/**
 * Runtime - assembles all modules into a runnable Claw instance
 *
 * Final assembly layer integrating L1-L4 modules into runnable Claw instance.
 * 详 design/architecture.md + design/modules/l4_runtime.md。
 */

import * as path from 'path';
import { randomHex } from '../../foundation/node-utils/index.js';

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { type FileSystem } from '../../foundation/fs/index.js';
// phase 1414: isFileNotFound import removed — HEARTBEAT.md 读迁 Heartbeat 模块 inbox-formatter
import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import { InboxListFailed, InboxMoveFailed } from '../../foundation/messaging/index.js';
import type { MessageFormatterRegistry } from '../../foundation/messaging/index.js';

import { DialogStore, performRegimeSwitch } from '../../foundation/dialog-store/index.js';
import { resolveContextWindow } from '../../foundation/llm-provider/model-context-windows.js';
import { loadReadFileState, clearReadFileState } from '../../foundation/file-tool/index.js';
// phase 1406: SummonTool import removed — Assembly 标准注册路径，G→F 单向依赖恢复
import { runReact } from '../agent-executor/index.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../step-executor/signals.js';
import type { CallerSnapshot } from '../../foundation/tool-protocol/index.js';
import { RUNTIME_AUDIT_EVENTS, REACT_LOOP_AUDIT_EVENTS, RELOAD_LLM_CONFIG_MESSAGE_TYPE } from './runtime-audit-events.js';
// phase 71: writeErrorResponse 消（error-response.ts 整删）
import { TASK_AUDIT_EVENTS } from '../async-task-system/index.js';
// phase 1414: HEARTBEAT_AUDIT_EVENTS import removed — heartbeat 自家 inbox-formatter 持 audit
// phase 1406: DIALOG_DIR no longer used here — regime-switch recovery path is owned by performRegimeSwitch helper
import { formatErr } from '../../foundation/node-utils/index.js';

import { makeStepNumber } from '../agent-executor/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Snapshot } from '../../foundation/snapshot/index.js';
import type { InboxReader, InboxEntry, InboxHandle, OutboxWriter } from '../../foundation/messaging/index.js';
import { ExecContextImpl } from '../../foundation/tools/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolRegistry, IToolExecutor } from '../../foundation/tools/index.js';
import { createContextInjector, type ContextInjector } from '../context_manager/injector.js';
import type { ContractSystem } from '../contract/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import {
  type RuntimeOptions,
  type StreamCallbacks,
  type IRuntimeLifecycle,
  type IRuntimeDaemon,
  type TurnResult,
} from './types.js';
import { TASKS_SYNC_DIR } from '../async-task-system/index.js';
import {
  maybeTrimProactive,
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_TARGET_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
} from '../context_manager/index.js';
import { trimAndPersist } from '../context_manager/trim-and-persist.js';
import { ContextTrimExhaustedError } from '../context_manager/errors.js';


import { formatTimeAgo } from './utils.js';

import type { TraceId } from './types/trace-id.js';
import { makeTraceId } from './types/trace-id.js';

function auditError(
  audit: AuditLog,
  event: string,
  err: unknown,
  ...extras: string[]
): void {
  audit.write(event, ...extras, `reason=${formatErr(err)}`);
}

// phase 1406: extractLastTurn 迁出 → foundation/dialog-store/regime-switch.ts（per M#2 业务归属）

/**
 * Runtime - fully assembled Claw runtime instance
 */
export class Runtime implements IRuntimeLifecycle, IRuntimeDaemon {
  protected options: RuntimeOptions;
  protected initialized = false;
  /** phase 522 C2: 防 stop 二次调用重 await 120s task timeout / contract close 二度 */
  private _stopped = false;
  private currentAbortController: AbortController | null = null;
  private turnCount = 0;
  protected auditWriter!: AuditLog;
  /** phase 1343 α-6: current turn-level trace id for cross-module audit correlation */
  private currentTraceId?: TraceId;

  /** phase 1343 α-6: expose current trace id for daemon-loop stream callbacks */
  getCurrentTraceId(): TraceId | undefined { return this.currentTraceId; }

  /** phase 146: delegate caller-snapshot to ExecContext (canonical source, direct read true owner) */
  async getCallerSnapshot(): Promise<CallerSnapshot> {
    if (!this.execContext?.getCallerSnapshot) {
      return { systemPrompt: '', tools: [], messages: [] };
    }
    return this.execContext.getCallerSnapshot();
  }

  // Foundation
  /**
   * @protected allows system-files read (SOUL.md, etc.) by create-runtime helper + identity-based system path builders
   * (phase 266 reframed MotionRuntime subclass to identity-based dispatch; preserve runtime encapsulation — no direct writes)
   */
  protected systemFs!: FileSystem;  // used by system components (no permission check)
  protected llm!: LLMOrchestrator;

  // Core
  protected sessionManager!: DialogStore;
  /**
   * @protected allows create-runtime helper to call buildParts() / customize prompt injection order
   * (phase 266 reframed MotionRuntime subclass to identity-based dispatch; treat as read-only — no injector state mutation)
   */
  protected contextInjector!: ContextInjector;
  protected toolRegistry!: ToolRegistry;
  private taskSystem!: AsyncTaskSystem;
  private contractManager!: ContractSystem;
  protected execContext!: ExecContext;
  protected toolExecutor!: IToolExecutor;
  private inboxReader!: InboxReader;
  protected outboxWriter!: OutboxWriter;
  private snapshot!: Snapshot;
  // phase 1414: inbox 消息 formatter 注册表（Assembly 装配期填、各业主自家）
  private formatterRegistry!: MessageFormatterRegistry;
  // phase 27 Step D P5: guidance compose callback hook
  private guidanceCompose?: import('./types.js').GuidanceCompose;

  // phase 521: regime switch coordination
  private dialogStoreFactory!: () => DialogStore;
  protected lastIdentityHash?: string;  // protected: TestRuntime subclass needs read access for regime switch tests
  // phase 440：上下文管理器运行时配置（filterSubtypes 等）
  private contextManagerConfig?: import('../step-executor/types.js').ContextManagerRuntimeConfig;
  /** phase 453：上次 LLM call 完成时刻 (ms epoch)；0 = 从未调用过、第一个 turn 不触发顺手裁 */
  private lastLLMCallAt: number = 0;
  /** phase 69: L6 Assembly 装配期注入 claw 子目录列表 */
  private clawSubdirs!: readonly string[];

  constructor(options: RuntimeOptions) {
    // phase 1485: ctor 不再 fallback DEFAULT_MAX_STEPS — assemble 层 undefined 直传、
    // runReact 接口接受 maxSteps?: number 并内部 fallback（运行时不变量 boundary）。
    this.options = {
      toolProfile: 'full',
      ...options,
    };
    // auditWriter now comes from dependencies (phase155B+)
    this.auditWriter = options.dependencies.auditWriter;
    const deps = options.dependencies;
    this.dialogStoreFactory = deps.dialogStoreFactory;
    this.clawSubdirs = deps.clawSubdirs;                // phase 69: DI 注入 claw 子目录列表
    this.formatterRegistry = deps.formatterRegistry;   // phase 1414: ctor-time bind（formatInboxMessage 可在 initialize 前调）
    this.guidanceCompose = deps.guidanceCompose;        // phase 27 Step D P5: callback hook
    this.contextManagerConfig = options.contextManagerConfig;
    if (deps.parentStreamLog) {
      deps.taskSystem.setParentStreamLog(deps.parentStreamLog);
    }
    if (deps.contractNotifyCallback) {
      deps.contractManager.setOnNotify(deps.contractNotifyCallback);
    }
  }

  /** phase 1343 α-6: set/clear turn-level trace id on audit writer */
  private setTraceId(traceId: TraceId | undefined): void {
    this.currentTraceId = traceId;
    const aw = this.auditWriter as unknown as { traceId?: TraceId };
    if (aw) aw.traceId = traceId;
  }

  /**
   * Initialize all modules
   */
  async initialize(opts?: { interruptionMessage?: string }): Promise<void> {
    if (this.initialized) return;

    const { clawDir } = this.options;
    const deps = this.options.dependencies;

    // 1. 基础 deps 提前赋值（ensureDirectories 需要 FileSystem）
    this.systemFs = deps.systemFs;

    // 2. 目录结构（业务初始化，Assembly 不管）
    await this.ensureDirectories(clawDir);

    // 3. 消费剩余 deps
    this.auditWriter = deps.auditWriter;
    this.llm = deps.llm;
    this.snapshot = deps.snapshot;
    this.sessionManager = deps.sessionManager;
    this.inboxReader = deps.inboxReader;
    try {
      await this.inboxReader.init();
    } catch (e) {
      auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.INBOX_INIT_FAILED, e);
      throw e;
    }
    this.outboxWriter = deps.outboxWriter;
    // phase 1414: formatterRegistry 已在 ctor 期初始化（initialize 前可用）
    this.toolRegistry = deps.toolRegistry;
    this.toolExecutor = deps.toolExecutor;
    this.contractManager = deps.contractManager;
    this.taskSystem = deps.taskSystem;
    // phase 1211: ContextInjector + ExecContext 是 Runtime 内部组件 (per arch.md:328)
    // 用既有 RuntimeDeps 字段自构造、不接受外部 inject
    this.contextInjector = createContextInjector({
      fs: this.systemFs,
      skillRegistry: deps.skillRegistry,
      contractManager: this.contractManager,
      audit: this.auditWriter,
    });
    this.execContext = new ExecContextImpl({
      clawId: this.options.clawId,
      clawDir: this.options.clawDir,
      syncDir: path.join(this.options.clawDir, TASKS_SYNC_DIR),
      profile: this.options.toolProfile ?? 'full',
      allowedGroups: this.options.allowedGroups, // phase 785: injected by Assembly
      callerLabel: this.options.callerLabel, // phase 797: injected by Assembly
      permissionChecker: deps.permissionChecker,  // NEW phase 1273
      fs: this.systemFs,
      fsFactory: this.options.dependencies.fsFactory,
      llm: this.llm,
      auditWriter: this.auditWriter,
      persistReadFileState: true,  // phase 1443: main claw ctx persists readFileState to <clawDir>/read-state.json
      // phase 146: M#3 资源唯一归属真治、直接 read 真 owner、不经 Runtime mirror state
      getCallerSnapshot: async () => {
        const { systemPrompt } = await this._resolveSystemPromptForRun();
        const tools = this.toolRegistry.formatForLLM(
          this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
        );
        const { session } = await this.sessionManager.load();
        return {
          systemPrompt,
          tools,
          messages: session.messages,
        };
      },
      registry: this.toolRegistry,
      baseRegistry: deps.baseToolRegistry,
    });

    // 3. Session repair（业务链路）
    //    load 后 in-memory recovery 即完成、current.json 不动。
    //    phase 405: 撤启动归档（archive() 不防长度增长、对 session 物理长度零控制效果；
    //    archive 入口保留在 regime-switch 真有 session 实体断裂语义的场景）。
    await this.repairSessionIfNeeded(opts?.interruptionMessage);

    // 4. AsyncTaskSystem 业务动作（M#2 归属消费者 / Assembly 只构造不调）
    try {
      await this.taskSystem.initialize();
    } catch (e) {
      auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.TASK_SYSTEM_INIT_FAILED, e);
      throw new Error(`Runtime: AsyncTaskSystem.initialize failed: ${formatErr(e)}`, { cause: e });
    }
    try {
      this.taskSystem.startDispatch();
    } catch (e) {
      auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.TASK_SYSTEM_START_DISPATCH_FAILED, e);
      throw new Error(`Runtime: AsyncTaskSystem.startDispatch failed: ${formatErr(e)}`, { cause: e });
    }

    // phase 1406: SummonTool 注册迁出 Runtime → Assembly 标准路径
    // （assemble.ts:251 toolRegistry.register(new SummonTool())）。
    // Runtime 不再反向 import 此 L4 Tool 类，G→F 单向依赖恢复。
    if (this.options.identityToolFilter) {
      this.options.identityToolFilter(this.toolRegistry);
    }

    // phase 1443: load readFileState from disk to survive daemon restart
    // (M#4「持久化一切信息到磁盘」 + DP「事后能完整重建任一时刻状态」).
    // Missing / corrupt file → empty Map + audit (fail-safe: claw must re-read).
    this.execContext.readFileState = await loadReadFileState(this.systemFs, this.auditWriter);

    this.initialized = true;
  }

  private async repairSessionIfNeeded(interruptionMessage?: string): Promise<void> {
    const loadResult = await this.sessionManager.load().catch((err) => {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.SESSION_REPAIR_FAILED,
        `context=load_skipped`,
        `reason=${formatErr(err)}`,
      );
      return null;
    });
    if (!loadResult) return;
    const { session, source } = loadResult;
    // interruptionMessage 由 caller（daemon）传入，runtime 不再直读 audit 文件
    this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SESSION_LOADED, `source=${source}`);
    const { repaired, toolCount } = DialogStore.repair(
      session.messages,
      interruptionMessage ? { interruptionMessage } : undefined,
    );
    if (toolCount > 0) {
      try {
        const repairTools = this.toolRegistry.formatForLLM(
          this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
        );
        await this.sessionManager.save({
          systemPrompt: session.systemPrompt,
          messages: repaired,
          toolsForLLM: repairTools,
        });
      } catch (e) {
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SESSION_REPAIR_FAILED, e);
        throw e;
      }
      this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SESSION_REPAIRED, `tools=${toolCount}`);
      const result = await this.snapshot.commit(`session-repair tools=${toolCount}`).catch((err: unknown): null => {
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, err, `context=session-repair`);
        return null;
      });
      if (result && !result.ok) {
        if (result.error.kind === 'uncategorized') {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=session-repair`, `exitCode=${result.error.exitCode}`);
        } else {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, `context=session-repair`, `kind=${result.error.kind}`);
        }
      }
    }
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    // phase 522 C2: 幂等 guard — disassemble 路径 + 测试/异常路径可能重入
    if (this._stopped) return;
    this._stopped = true;
    this.abort();
    const timedOut = await this.taskSystem.shutdown(120_000);
    if (timedOut) {
      // phase 1332 N4: timeout edge case abort path — ensure tasks are killed before llm.close
      // 防 phase 1286 100M tokens cascade 后 task 长跑 1-2min / 子代理资源继承
      this.taskSystem.abort();
      this.auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_SHUTDOWN_TIMEOUT_HIT,
        `timeout_ms=120000`,
      );
    }
    // phase 1024 G.3: await pending dialogStore.save() flush before close
    // 防 SIGTERM 时半写 dialog 落盘 / DP「外部信号到达不能丢失状态」
    await this.sessionManager.getFlushPromise().catch(() => {
      /* save error 已经 audit.SAVE_FAILED emit / barrier 不阻塞 stop */
    });
    // phase 324 H5: 关 ContractSystem、abort 仍活的 verifier AbortController 串、
    // await 其 termination promise。否则 SIGTERM 留 verifier LLM stream 泄漏
    // —— 正是 phase 1332 N4 + close() 引入要防的。
    await this.contractManager.close().catch(() => {
      /* close error 已 audit emit / barrier 不阻塞 stop */
    });
    await this.llm.close();
  }

  /**
   * Format the injection text for an inbox message by its type.
   * user_chat: no prefix (user typed in the chat)
   * user_inbox_message: [user inbox message] prefix (user sent a message via CLI)
   * system events: [system message] prefix
   */
  /**
   * phase 1414: Runtime 收窄为纯 dispatch + DP 不静默 fallback。
   * 各业主模块（Messaging / Heartbeat / Watchdog / Gateway）在 Assembly 装配期
   * 通过 formatterRegistry 自家 register 自家 message type formatter。
   * Runtime 不字面持任何上下游 message type / 措辞 / FS 读 / 业主 audit。
   */
  protected async formatInboxMessage(
    type: string,
    from: string,
    body: string,
    timestamp?: string,
    extraMeta?: Record<string, string>,
  ): Promise<string> {
    const ago = timestamp ? formatTimeAgo(timestamp) : '';
    const t = ago ? ` (${ago})` : '';

    const formatter = this.formatterRegistry.resolve(type);
    let formatted: string;
    if (!formatter) {
      // DP 不静默：未注册 type 必 audit + 走默 fallback（不丢消息）
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_UNKNOWN_TYPE,
        `type=${type}`,
        `from=${from}`,
      );
      formatted = `[system message${t}] ${body}`;
    } else {
      formatted = await formatter({ from, body, timestampSec: t });
    }

    // phase 27 Step D P5: motion-side append guidance（motion 装配 guidanceCompose 必持 / claw undefined → 跳）
    if (this.guidanceCompose) {
      try {
        const g = this.guidanceCompose(type, extraMeta ?? {});
        if (g) formatted += '\n\n' + g.text;
      } catch (e) {
        // 不可预期失败暴露 / audit emit / 不破 message 投递（fallback graceful、仅缺 guidance 追加）
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.GUIDANCE_COMPOSER_FAILED,
          `type=${type}`,
          `reason=${formatErr(e)}`,
        );
      }
    }
    return formatted;
  }

  /**
   * Read and drain inbox/pending/*.md for this instance.
   * Uses drainAndDeliver() to move files to inflight/ (delivered but not yet acked).
   * Unaddressed messages are immediately acked; addressed handles returned for turn-end ack.
   * @protected available for create-runtime helper reuse (phase 266 reframed MotionRuntime subclass to identity-based dispatch)
   */
  async drainInbox(): Promise<{
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    count: number;
    infos: InboxMessage[];
    addressedHandles: InboxHandle[];
  }> {
    return this._drainOwnInbox();
  }

  protected async _drainOwnInbox(): Promise<{
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    count: number;
    infos: InboxMessage[];
    addressedHandles: InboxHandle[];
  }> {
    const { entries, handles } = await this._drainEntriesOrEmpty();
    if (entries.length === 0) {
      return { injected: [], sources: [], count: 0, infos: [], addressedHandles: [] };
    }

    // phase 320: hot-reload 拦截 — reload_llm_config 旁路、不入 AI 上下文、不入 turn lifecycle
    const reloadEntries = entries.filter(e => e.message.type === RELOAD_LLM_CONFIG_MESSAGE_TYPE);
    const nonReloadEntries = entries.filter(e => e.message.type !== RELOAD_LLM_CONFIG_MESSAGE_TYPE);
    if (reloadEntries.length > 0) {
      await this._handleReloadEntries(reloadEntries, handles);
    }
    if (nonReloadEntries.length === 0) {
      return { injected: [], sources: [], count: 0, infos: [], addressedHandles: [] };
    }

    const { addressed } = this._splitAndAuditEntries(nonReloadEntries);
    const { injected, sources } = await this._formatInjected(addressed);

    // phase 442 (review N3-C-H1 / R2-C-N1): unaddressed (to=<other_claw>) 消息
    // 移到 misrouted/ 隔离、不 ack 到 done/。文件保留 + 独立子目录 →
    // DP「持久化一切信息」+「事后可审计」满足；转发候选违反 ML#5（runtime
    // 探测目标 claw 存在）、应然推导排除（详 phase 442 总览）。
    // 既有 INBOX_UNADDRESSED audit 在 _splitAndAuditEntries 内仍 emit（已识别）；
    // 此处 markMisrouted 内 emit INBOX_MISROUTED（已移到 fs）—— 双 event 叠加。
    const addressedPaths = new Set(addressed.map(e => e.filePath));
    const unaddressedHandles = handles.filter(h => !addressedPaths.has(h.filePath));
    for (const h of unaddressedHandles) {
      try {
        await this.inboxReader.markMisrouted(h);
      } catch (e) {
        // best-effort; markMisrouted 内已发 INBOX_MOVE_FAILED(op=misrouted) audit
      }
    }

    const addressedHandles = handles.filter(h => addressedPaths.has(h.filePath));
    return {
      injected,
      sources,
      count: addressed.length,
      infos: addressed.map(e => e.message),
      addressedHandles,
    };
  }

  /**
   * phase 320: 处理 reload_llm_config 拦截消息。
   * - 同批 N 条只 reload 1 次（idempotent / 都读最新磁盘）
   * - reload 消息无视 to 字段（reload 是「daemon 自家配置」、to 无意义）
   * - 所有 reload 消息一律 ack（成功 / 失败 / skipped 都已消费、不留在 inflight）
   */
  private async _handleReloadEntries(reloadEntries: InboxEntry[], handles: InboxHandle[]): Promise<void> {
    const reloadPaths = new Set(reloadEntries.map(e => e.filePath));
    const reloadHandles = handles.filter(h => reloadPaths.has(h.filePath));

    if (!this.options.configReloader) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.LLM_RELOAD_SKIPPED,
        `count=${reloadEntries.length}`,
        `reason=no_reloader_configured`,
      );
    } else {
      try {
        const newConfig = this.options.configReloader();
        this.llm.reloadConfig(newConfig);
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
          `provider=${newConfig.primary.name ?? 'unknown'}`,
          `fallbacks=${newConfig.fallbacks?.length ?? 0}`,
          `triggered_by=${reloadEntries.length}`,
        );
      } catch (err) {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.LLM_RELOAD_FAILED,
          `reason=${formatErr(err)}`,
        );
      }
    }

    for (const h of reloadHandles) {
      try {
        await this.inboxReader.ack(h);
      } catch (ackErr) {
        // phase 525 (review-round4 Core L): observability、防 ack 失败时 reconcile
        // 把 reload 消息移回 pending → 下次 drain 重复 reload。延续 phase 521
        // INBOX_ACK_FAILED forensic 模式（path=reload_entries 区分）。
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.INBOX_ACK_FAILED,
          `file=${h.originalFileName}`,
          `path=reload_entries`,
          `error=${formatErr(ackErr)}`,
        );
      }
    }
  }

  private async _drainEntriesOrEmpty(): Promise<{ entries: InboxEntry[]; handles: InboxHandle[] }> {
    try {
      return await this.inboxReader.drainAndDeliver();
    } catch (err) {
      if (err instanceof InboxListFailed || err instanceof InboxMoveFailed) {
        // phase 567: 加 trace_id forensic field（optional chain 兜底 init 调用路径）
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.INBOX_DRAIN_FAILED,
          `error=${err.constructor.name}`,
          `reason=${formatErr(err)}`,
          `trace_id=${String(this.execContext?.trace_id ?? '')}`,
        );
        return { entries: [], handles: [] };
      }
      throw err;
    }
  }

  private _splitAndAuditEntries(entries: InboxEntry[]): {
    addressed: InboxEntry[];
    unaddressed: InboxEntry[];
  } {
    const addressed: InboxEntry[] = [];
    const unaddressed: InboxEntry[] = [];
    for (const entry of entries) {
      const to = entry.message.to;
      if (!to || to === this.options.clawId) {
        addressed.push(entry);
      } else {
        unaddressed.push(entry);
      }
    }
    // phase 565: forensic 完整化、加 trace_id 跨源 join 到 turn
    // （execContext 在 test 直接调用时可能未设 trace_id、optional chain 兜底）
    const traceCol = `trace_id=${String(this.execContext?.trace_id ?? '')}`;
    for (const { message, filePath } of addressed) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_INJECT,
        `file=${path.basename(filePath)}`,
        `type=${message.extraMeta?.__original_type ?? message.type}`,
        `from=${message.from}`,
        `to=${message.to || this.options.clawId}`,
        `pri=${message.priority}`,
        traceCol,
      );
    }
    for (const { message, filePath } of unaddressed) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_UNADDRESSED,
        `file=${path.basename(filePath)}`,
        `type=${message.extraMeta?.__original_type ?? message.type}`,
        `from=${message.from}`,
        `to=${message.to}`,
        // phase 434 Step A (review N11 partial): contract_id forensic field
        // — cross-source join with contract audit log when sender attached
        // metadata.contract_id; empty string when not present.
        `contract_id=${message.metadata?.contract_id ?? ''}`,
        traceCol,
      );
    }
    return { addressed, unaddressed };
  }

  private async _formatInjected(addressed: InboxEntry[]): Promise<{
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
  }> {
    const injected: Message[] = [];
    const sources: Array<{ text: string; type: string }> = [];
    const now = new Date().toISOString();
    for (const { message } of addressed) {
      const formatted = await this.formatInboxMessage(
        message.type,
        message.from,
        message.content,
        message.timestamp,
        message.extraMeta,   // phase 1469: motion-side guidance composer reads state from extraMeta
      );
      // phase 436: user_chat + user_inbox_message → 用户意图来源（origin='user'）
      // 其他 inbox type → 系统事件（origin='system' + systemSubtype = InboxMessage.type 单源）
      const isUserOrigin = message.type === 'user_chat' || message.type === 'user_inbox_message';
      injected.push({
        role: 'user',
        content: formatted,
        origin: isUserOrigin ? 'user' : 'system',
        ...(isUserOrigin ? {} : { systemSubtype: message.type }),
        addedAt: now,
      });
      sources.push({
        text: formatted.replace(/\r?\n/g, ' '),
        type: message.type,
      });
    }
    return { injected, sources };
  }

  /**
   * 装配 turn 上下文：traceId + abort controller。
   * 返回 cleanup 函数 + traceId 供 finally 块调用。
   */
  private _setupTurnContext(reuseTraceId?: TraceId): {
    traceId: TraceId;
    abortController: AbortController;
    cleanup: () => void;
  } {
    const traceId = reuseTraceId ?? makeTraceId(randomHex(8));
    this.setTraceId(traceId);
    this.execContext.trace_id = traceId;
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    return {
      traceId,
      abortController,
      cleanup: () => {
        this.currentAbortController = null;
        this.execContext.signal = undefined;
        this.setTraceId(undefined);
        this.execContext.trace_id = undefined;
      },
    };
  }

  /** per-handle ack with atomic audit on failure. */
  async ackHandles(handles: InboxHandle[], path: string): Promise<void> {
    for (const h of handles) {
      try {
        await this.inboxReader.ack(h);
      } catch (ackErr) {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.INBOX_ACK_FAILED,
          `file=${h.originalFileName}`,
          `path=${path}`,
          `trace_id=${String(this.execContext.trace_id ?? '')}`,
          `error=${formatErr(ackErr)}`,
        );
      }
    }
  }

  /** per-handle nack with atomic audit on failure. */
  async nackHandles(handles: InboxHandle[], reason: string, path: string): Promise<void> {
    for (const h of handles) {
      try {
        await this.inboxReader.nack(h, reason);
      } catch (nackErr) {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.INBOX_NACK_FAILED,
          `file=${h.originalFileName}`,
          `path=${path}`,
          `trace_id=${String(this.execContext.trace_id ?? '')}`,
          `error=${formatErr(nackErr)}`,
        );
      }
    }
  }

  /**
   * Run the LLM ReAct loop over the given messages and save the session.
   * @protected available for create-runtime helper reuse (phase 266 reframed MotionRuntime subclass to identity-based dispatch)
   */
  protected async _runReact(messages: Message[], systemPrompt: string, tools: ToolDefinition[], callbacks?: StreamCallbacks): Promise<void> {
    // phase 786: stopRequested 是 per-turn flag，每 turn 起首 reset
    // 防 P0.14 跨 turn sticky bug（done 工具误调后下 turn silent empty）
    this.execContext.stopRequested = false;
    // 解析一次 regime/identity 信息；LLM 仍使用 caller 传入的 systemPrompt（兼容 processWithMessage 等旧入口）
    const { systemPrompt: resolvedSystemPrompt, identityContent } = await this._resolveSystemPromptForRun();

    // phase 518 (review-round4 N4-Core-H3): per-turn cache contract_id for tool event audit
    // forensic join 路径（与 phase 434 messaging path 对称）。loadActive 抛错 silent +
    // fallback ''、防 contract loader corruption 拦 turn execution。
    let currentContractId = '';
    try {
      const active = await this.contractManager.loadActive();
      if (active) currentContractId = active.id;
    } catch (loadErr) {
      // phase 555 (拆 phase 544 misuse): contract loader 半态时 tool emit fallback ''、
      // 不阻 turn execution、forensic 留痕走专属 event TURN_CONTRACT_ID_CACHE_FAILED
      // （phase 544 误用 MAYBE_AUDIT_STEP_FAILED 让 onStepComplete 路径 forensic 混淆）。
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.TURN_CONTRACT_ID_CACHE_FAILED,
        `trace_id=${String(this.execContext.trace_id ?? '')}`,
        `error=${this.auditWriter.message(formatErr(loadErr))}`,
      );
    }

    // 首个 LLM 输出 delta 时上报当前生效的 provider（确认 API 可用后才显示）
    let providerInfoEmitted = false;
    const emitProviderInfoOnce = () => {
      if (!providerInfoEmitted) {
        const info = this.llm.getProviderInfo();
        if (info) {
          providerInfoEmitted = true;
          callbacks?.onProviderInfo?.(info);
        }
      }
    };


    try {
      await runReact({
        messages,
        systemPrompt,
        llm: this.llm,
        executor: this.toolExecutor,
        ctx: this.execContext,
        tools,
        registry: this.toolRegistry,  // Enable parallel execution for readonly tools
        maxSteps: this.options.maxSteps,
        maxConsecutiveParseErrors: this.options.maxConsecutiveParseErrors,
        maxConsecutiveMaxTokensToolUse: this.options.maxConsecutiveMaxTokensToolUse,
        idleTimeoutMs: this.options.idleTimeoutMs,
        auditWriter: this.auditWriter,
        currentContractId,
        onLLMResult: (info) => {
          // phase 453: 每次 LLM call 完成后更新、供下轮 turn 入口判顺手裁
          this.lastLLMCallAt = Date.now();
          if (info.error) {
            // phase 525 (review-round4 Core L): error 走 auditWriter.message() sanitize、
            // 防长 stack / base64 灌 audit、与其他 catch 路径对齐
            // phase 560: 加 trace_id forensic field 跨源 join（与 phase 557 模式对齐）
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_ERROR, info.model, `trace_id=${String(this.execContext.trace_id ?? '')}`, `error=${this.auditWriter.message(info.error)}`, `latency_ms=${info.latencyMs}`);
          } else {
            // phase 560: 同上
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_CALL, info.model, `trace_id=${String(this.execContext.trace_id ?? '')}`, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `latency_ms=${info.latencyMs}`);
          }
        },
        onStepComplete: async (stepCount) => {
          await this.sessionManager.save({ systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId });
          // phase 1424: contract auditor 周期 LLM 对照 expectations 检查
          // fire-and-forget（不阻塞 Runtime step / 反馈走 inbox high priority 下轮 step 起 PriorityInboxInterrupt 中断）
          // phase 446 (review): 防御 .catch 兜底 unhandledRejection（内部已多层容错、本 catch 几乎不触发）
          void this.contractManager.maybeAuditStep(makeStepNumber(stepCount))
            .catch(err => {
              // phase 563: 加 trace_id forensic field（延续 phase 557/560 模式）
              this.auditWriter.write(
                RUNTIME_AUDIT_EVENTS.MAYBE_AUDIT_STEP_FAILED,
                `step_count=${stepCount}`,
                `trace_id=${String(this.execContext.trace_id ?? '')}`,
                `error=${formatErr(err)}`,
              );
            });
          // 步间检查：高优先级消息到达时提前结束本轮
          if (await this._hasHighPriorityInbox()) {
            this.currentAbortController?.abort({ type: 'step_yield' });
          }
        },
        onTextDelta: (d) => { emitProviderInfoOnce(); callbacks?.onTextDelta?.(d); },
        onTextEnd: callbacks?.onTextEnd,
        onThinkingDelta: (d) => { emitProviderInfoOnce(); callbacks?.onThinkingDelta?.(d); },
        onToolCall: callbacks?.onToolCall,
        // phase 688: API 收到的 args body 落 stream.jsonl（daemon callback 已实现 onToolUseInput、此处仅透传）
        // 与 onToolCallInput（audit-only size index）互补、不重复 audit。
        onToolUseInput: callbacks?.onToolUseInput,
        // phase 730: TOOL_RESULT audit moved to AgentExecutor; Runtime only passes through callback.
        onToolResult: callbacks?.onToolResult,
        onBeforeLLMCall: () => { callbacks?.onBeforeLLMCall?.(); },
        onReset: (provider, timeoutMs) => {
          providerInfoEmitted = false;
          callbacks?.onProviderFailover?.({ from: provider, timeoutMs });
        },
        onProviderFailed: (provider, model, error) => {
          callbacks?.onProviderFailed?.({ provider, model, error });
        },

        streamCallbacks: callbacks,
      });
      await this.sessionManager.save({ systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId });

      // turn auto-commit
      this.turnCount++;
      const commitResult = await this.snapshot.commit(`turn-${this.turnCount} ${new Date().toISOString()}`).catch((err: unknown): null => {
        // 不可预期失败：audit 已在 snapshot 内写；此处仅暴露给诊断
        // phase 567: 加 trace_id forensic field（turn 末路径 execContext.trace_id 已设）
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, err, `context=turn-${this.turnCount}`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);
        return null;
      });
      if (commitResult && !commitResult.ok) {
        // phase 567: 加 trace_id forensic field
        const traceCol = `trace_id=${String(this.execContext?.trace_id ?? '')}`;
        if (commitResult.error.kind === 'uncategorized') {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=turn-${this.turnCount}`, `exitCode=${commitResult.error.exitCode}`, traceCol);
        } else {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, `context=turn-${this.turnCount}`, `kind=${commitResult.error.kind}`, traceCol);
        }
      }

      // phase 521: turn 末 regime change 检测（per L5.G3 (a) 自动检测）
      await this._checkRegimeSwitch(resolvedSystemPrompt, identityContent);
    } finally {
      // phase 146: mirror state removed — no reset needed
    }
  }

  /**
   * Execute a single ReAct turn for the given messages.
   * Orchestration-free: callers decide drain/trim/ack/nack/retry policy.
   */
  async processTurn(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
    callbacks?: StreamCallbacks,
    reuseTraceId?: TraceId,
  ): Promise<TurnResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { cleanup } = this._setupTurnContext(reuseTraceId);
    try {
      // phase 569: 加 trace_id forensic field（turn 入口 trace_id 已设）
      // phase 722: 加 caller col 区分 processTurn caller 路径
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START, `caller=processTurn`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);

      await this.sessionManager.beginTurn();
      await this.sessionManager.save({
        systemPrompt,
        messages,
        toolsForLLM,
        trace_id: this.currentTraceId,
      });

      // 新 turn 开始 → 重置 lastSuccessProvider，让本 turn 第一步从 primary 开始挑 model
      this.llm.resetLastSuccessProvider?.();

      try {
        await this._runReact(messages, systemPrompt, toolsForLLM, callbacks);

        callbacks?.onTurnEnd?.();
        // phase 569: 加 trace_id forensic field
        // phase 722: 加 caller col 区分 processTurn caller 路径
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END, `caller=processTurn`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);
        await this.sessionManager.commitTurn();
        return { status: 'success' };
      } catch (err) {
        handleTurnInterrupt(err, this.auditWriter, callbacks, this.execContext?.trace_id ? String(this.execContext.trace_id) : undefined);
        if (err instanceof PriorityInboxInterrupt
            || err instanceof UserInterrupt
            || err instanceof IdleTimeoutSignal) {
          const cause = err instanceof PriorityInboxInterrupt ? 'priority_inbox'
                       : err instanceof UserInterrupt          ? 'user_interrupt'
                       :                                         'idle_timeout';
          await this.sessionManager.commitTurn(cause);
          return { status: 'interrupted', error: err, cause };
        } else {
          await this.sessionManager.rollbackTurn(formatErr(err));
          return { status: 'failed', error: err };
        }
      }
    } finally {
      cleanup();
    }
  }


  /**
   * Process a single synthetic message directly (without draining inbox).
   * Used by daemon-loop for in-process startup trigger — message is never persisted to disk.
   */
  async processWithMessage(msg: Message, callbacks?: StreamCallbacks): Promise<TurnResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const { traceId, cleanup } = this._setupTurnContext();
    try {
      const { session } = await this.sessionManager.load();
      const enrichedMsg = msg.addedAt ? msg : { ...msg, addedAt: new Date().toISOString() };
      const tools = this.getToolsForLLM();
      const systemPrompt = session.systemPrompt;
      let messages = [...session.messages, enrichedMsg];
      messages = await this.proactiveTrimIfNeeded(messages, systemPrompt, tools);

      callbacks?.onTurnStart?.([]);
      // phase 569: 加 trace_id forensic field（turn 入口 trace_id 已设）
      // phase 722: 加 caller col 区分 with_message caller 路径
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START, `caller=with_message`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);

      return await this.processTurn(messages, systemPrompt, tools, callbacks, traceId);
    } finally {
      cleanup();
    }
  }

  /**
   * Retry the last turn without draining inbox.
   * Used by daemon-loop to recover from transient LLM errors.
   */
  async retryLastTurn(callbacks?: StreamCallbacks): Promise<TurnResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const { traceId, cleanup } = this._setupTurnContext();
    try {
      const { session } = await this.sessionManager.load();
      if (session.messages.length === 0) {
        return { status: 'failed', error: 'no messages to retry' };
      }

      // Find the last user message boundary for safe retry.
      // If messages end after assistant/tool_result steps, truncate back to the last
      // user message so we don't re-run from a partial state that could re-execute
      // non-idempotent tools.
      let retryMessages = session.messages;
      const lastUserIdx = [...session.messages].map(m => m.role).lastIndexOf('user');
      if (lastUserIdx === -1) {
        // No user message at all — nothing to retry
        return { status: 'failed', error: 'no user message to retry' };
      }
      if (lastUserIdx < session.messages.length - 1) {
        // Messages have assistant/tool content after the last user message.
        // Truncate so the retry starts from a clean user turn boundary.
        retryMessages = session.messages.slice(0, lastUserIdx + 1);
        await this.sessionManager.save({
          systemPrompt: session.systemPrompt,
          messages: retryMessages,
          toolsForLLM: this.getToolsForLLM(),
        });
      }

      // Retry is also a turn (tag it so stream consumers know it's a retry)
      callbacks?.onTurnStart?.([{ text: 'LLM retry', type: 'system_retry' }]);
      // phase 569: 加 trace_id forensic field（turn 入口 trace_id 已设）
      // phase 722: 加 caller col 区分 retry caller 路径
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START, `caller=retry`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);

      return await this.processTurn(retryMessages, session.systemPrompt, this.getToolsForLLM(), callbacks, traceId);
    } finally {
      cleanup();
    }
  }

  /**
   * Abort the currently running turn
   */
  abort(): void {
    this.currentAbortController?.abort({ type: 'user' });
  }

  /**
   * Check if inbox has high/critical priority messages
   */
  private async _hasHighPriorityInbox(): Promise<boolean> {
    const metas = await this.inboxReader.peekMetas({ priority: ['high', 'critical'] });
    return metas.length > 0;
  }

  /**
   * Get runtime status (for diagnostics)
   */
  getStatus(): {
    initialized: boolean;
    clawId: string;
  } {
    return {
      initialized: this.initialized,
      clawId: this.options.clawId,
    };
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Get AsyncTaskSystem instance (for retrospective scheduling)
   */
  getTaskSystem(): AsyncTaskSystem {
    return this.taskSystem;
  }

  // ============================================================================
  // Protected methods (may be overridden by subclasses)
  // ============================================================================

  /**
   * Build the system prompt (may be overridden by subclasses to customize injection order).
   * Default behavior: AGENTS.md + MEMORY.md + skills + contract
   */
  protected async buildSystemPrompt(): Promise<string> {
    if (this.options.systemPromptBuilder) {
      return this.options.systemPromptBuilder({
        contextInjector: this.contextInjector,
        systemFs: this.systemFs,
        audit: this.auditWriter,
      });
    }
    return this.contextInjector.buildSystemPrompt();
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /**
   * Resolve systemPrompt + identityContent for a turn run.
   * - If systemPromptBuilder is configured, use full prompt as identityContent (U3 (a) / phase 521 兼容).
   * - Else, use contextInjector.buildSystemPromptForRegime() to get full + identityContent 分层。
   */
  private async _resolveSystemPromptForRun(): Promise<{
    systemPrompt: string;
    identityContent: string;
  }> {
    if (this.options.systemPromptBuilder) {
      const systemPrompt = await this.buildSystemPrompt();
      return { systemPrompt, identityContent: systemPrompt };
    }
    const r = await this.contextInjector.buildSystemPromptForRegime();
    return { systemPrompt: r.full, identityContent: r.identityContent };
  }

  /** Resolve the system prompt for an upcoming turn. */
  async getSystemPrompt(): Promise<string> {
    const { systemPrompt } = await this._resolveSystemPromptForRun();
    return systemPrompt;
  }

  /** Format tools for the current tool profile. */
  getToolsForLLM(): ToolDefinition[] {
    return this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );
  }

  /** Load current session messages for turn construction. */
  async getMessages(): Promise<Message[]> {
    const { session } = await this.sessionManager.load();
    return session.messages;
  }

  /** Proactive context trim before a turn; returns the (possibly trimmed) messages. */
  async proactiveTrimIfNeeded(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
  ): Promise<Message[]> {
    if (!this.contextManagerConfig || !this.sessionManager) {
      return messages;
    }
    const providerInfo = this.llm.getProviderInfo?.();
    const contextWindow = resolveContextWindow(providerInfo?.model);
    const trimResult = await maybeTrimProactive({
      messages,
      systemPrompt,
      toolsForLLM,
      contextWindow,
      lastLLMCallAt: this.lastLLMCallAt,
      filterSubtypes: this.contextManagerConfig.filterSubtypes,
      dialogStore: this.sessionManager,
      audit: this.auditWriter,
    });
    return trimResult ? trimResult.newMessages : messages;
  }

  /** Reactive context trim for the current session (in-place). */
  async reactiveTrim(): Promise<void> {
    if (!this.contextManagerConfig || !this.sessionManager) {
      return;
    }
    const { session } = await this.sessionManager.load();
    const tools = this.getToolsForLLM();
    const providerInfo = this.llm.getProviderInfo?.();
    const contextWindow = resolveContextWindow(providerInfo?.model);
    this.auditWriter.write(
      RUNTIME_AUDIT_EVENTS.REACTIVE_TRIM_TRIGGERED,
      `provider=${providerInfo?.name ?? 'unknown'}`,
      `trace_id=${String(this.execContext?.trace_id ?? '')}`,
    );
    try {
      await trimAndPersist({
        messages: session.messages,
        systemPrompt: session.systemPrompt,
        toolsForLLM: tools,
        contextWindow,
        recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
        targetRatio: CONTEXT_TRIM_TARGET_RATIO,
        previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
        filterSubtypes: this.contextManagerConfig.filterSubtypes,
        dialogStore: this.sessionManager,
        audit: this.auditWriter,
        triggerKind: 'reactive_overflow',
      });
    } catch (trimErr) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.REACTIVE_TRIM_EXHAUSTED,
        `provider=${providerInfo?.name ?? 'unknown'}`,
        `trace_id=${String(this.execContext?.trace_id ?? '')}`,
        `error=${formatErr(trimErr)}`,
      );
      if (trimErr instanceof ContextTrimExhaustedError) {
        return; // trim 裁不动不是错误，剩余交给 LLM 处理
      }
      throw trimErr;
    }
  }

  private async ensureDirectories(_clawDir: string): Promise<void> {
    for (const dir of this.clawSubdirs) {
      await this.systemFs.ensureDir(dir);
    }
  }

  getAuditWriter(): AuditLog {
    return this.auditWriter;
  }

  // ============================================================================
  // phase 521: regime switch coordination
  // ============================================================================

  private async _checkRegimeSwitch(newSystemPrompt: string, identityContent: string): Promise<void> {
    if (this.lastIdentityHash !== undefined && this.lastIdentityHash !== identityContent) {
      try {
        await this._performRegimeSwitch(newSystemPrompt);
        this.lastIdentityHash = identityContent;
      } catch (err) {
        // phase 573: 加 trace_id forensic field（_checkRegimeSwitch 由 turn 末调、trace_id 已设）
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED, err, `trace_id=${String(this.execContext?.trace_id ?? '')}`);
        // lastIdentityHash 不更新 → 下 turn 重试自愈（D7）
      }
    } else {
      this.lastIdentityHash = identityContent;
    }
  }

  /**
   * phase 1406: regime switch 实质逻辑迁出 → `foundation/dialog-store/regime-switch.ts`
   *   `performRegimeSwitch(opts)` helper（dialog 资源重组归 DialogStore module）
   * Runtime 仅保留薄壳：装配 opts + 调 helper + commit `this.sessionManager`。
   *
   * 设计 align：M#2 业务语义归属（dialog 重组 = DialogStore 业务）+ M#3 资源唯一
   * 归属（dialog messages + archive + factory 全在 DialogStore 持）+ DP 中断可恢复
   * atomicity（phase 600/646 invariants 不破、audit 命名空间不变）。
   */
  private async _performRegimeSwitch(newSystemPrompt: string): Promise<void> {
    const regimeTools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full'),
    );
    const result = await performRegimeSwitch({
      strategy: this.options.regimeSwitchStrategy ?? 'all',
      newSystemPrompt,
      currentStore: this.sessionManager,
      dialogStoreFactory: this.dialogStoreFactory,
      toolsForLLM: regimeTools,
      clawDir: this.options.clawDir,
      systemFs: this.systemFs,
      audit: this.auditWriter,
      auditEvents: {
        REGIME_SWITCH: RUNTIME_AUDIT_EVENTS.REGIME_SWITCH,
        REGIME_SWITCH_COMMITTED: RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_COMMITTED,
        REGIME_SWITCH_FAILED: RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED,
        REGIME_SWITCH_HARD_FAIL: RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_HARD_FAIL,
      },
      // phase 1443: clear readFileState (in-memory + disk) after regime switch commits.
      // Dialog context was just purged; gate state must be purged too, else next overwrite
      // bypasses the "claw must have seen the file" intent post-compaction.
      onSwitchComplete: () => clearReadFileState(this.execContext),
    });
    // commit 替换（caller responsibility per regime-switch.ts JSDoc）
    this.sessionManager = result.newStore;
  }

}

/**
 * phase 71: handleTurnInterrupt 从 error-response.ts 内联（error-response.ts 整删）。
 * 处理 turn 中断信号 (idle timeout / priority inbox / user interrupt) 或一般 error。
 */
export function handleTurnInterrupt(
  err: unknown,
  audit: AuditLog,
  callbacks?: StreamCallbacks,
  traceId?: string,  // phase 571: forensic field、optional 兼容既有 test caller
): void {
  // phase 571: trace_id col fallback ''、test 不传时为空 col 保 forensic 形态一致
  const traceCol = `trace_id=${traceId ?? ''}`;
  if (err instanceof IdleTimeoutSignal) {
    const msg = `Interrupted (idle timeout: ${Math.round(err.timeoutMs / 1000)}s)`;
    callbacks?.onTurnInterrupted?.('idle_timeout', msg);
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${err.timeoutMs}`, traceCol);
  } else if (err instanceof PriorityInboxInterrupt) {
    callbacks?.onTurnInterrupted?.('priority_inbox', 'Interrupted (priority inbox)');
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox', traceCol);
  } else if (err instanceof UserInterrupt) {
    callbacks?.onTurnInterrupted?.('user_interrupt');
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt', traceCol);
  } else {
    const errorMsg = formatErr(err);
    callbacks?.onTurnError?.(errorMsg);
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${errorMsg}`, traceCol);
  }
}

