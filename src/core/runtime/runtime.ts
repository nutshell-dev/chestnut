/**
 * Runtime - assembles all modules into a runnable Claw instance
 *
 * Final assembly layer integrating L1-L4 modules into runnable Claw instance.
 * 详 design/architecture.md + design/modules/l4_runtime.md。
 */

import * as path from 'path';
import { randomHex, sha256Hex } from '../../foundation/node-utils/index.js';

import type { LLMOrchestrator, LLMRuntimeCapability, LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import { type FileSystem } from '../../foundation/fs/index.js';
// phase 1414: isFileNotFound import removed — HEARTBEAT.md 读迁 Heartbeat 模块 inbox-formatter
import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import type { InboxMessageRenderingResolver } from '../../foundation/messaging/index.js';
import { renderStandardInboxMessage } from '../../foundation/messaging/index.js';

import {
  applyBlockIdAssignments,
  DIALOG_AUDIT_EVENTS,
  performRegimeSwitch,
  repairDialogMessages,
  type DialogSessionLifecycle,
} from '../../foundation/dialog-store/index.js';
import { resolveContextWindow } from '../../foundation/llm-provider/index.js';
import { loadReadFileState, clearReadFileState, persistReadFileState } from '../../foundation/file-tool/index.js';
// phase 1406: SummonTool import removed — Assembly 标准注册路径，G→F 单向依赖恢复
import { runReact } from '../agent-executor/index.js';
import type { RuntimeTurnCallbacks } from './turn-callbacks.js';
import { createAgentExecutorAuditSink } from './agent-executor-audit-sink.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../step-executor/index.js';
import type { CallerSnapshot } from '../../foundation/tool-protocol/index.js';
import { RUNTIME_AUDIT_EVENTS, REACT_LOOP_AUDIT_EVENTS } from './runtime-audit-events.js';
import { RELOAD_LLM_CONFIG_MESSAGE_TYPE } from './inbox-message-types.js';
// phase 71: writeErrorResponse 消（error-response.ts 整删）
import { TASK_AUDIT_EVENTS } from '../async-task-system/index.js';
// phase 1414: HEARTBEAT_AUDIT_EVENTS import removed — heartbeat 自家 inbox-formatter 持 audit
// phase 1406: DIALOG_DIR no longer used here — regime-switch recovery path is owned by performRegimeSwitch helper
import { formatErr } from '../../foundation/node-utils/index.js';

import { makeStepNumber } from '../agent-executor/index.js';
import { makeTraceId, type AuditLog, type TraceId } from '../../foundation/audit/index.js';
import type { SnapshotCommitter } from '../../foundation/snapshot/index.js';
import type { InboxDeliveryBatch, InboxDeliverySession, InboxEntry, InboxHandle } from '../../foundation/messaging/index.js';
import { ExecContextImpl } from '../../foundation/tools/index.js';
import { CLAWSPACE_DIR, TASKS_SYNC_DIR } from '../../foundation/claw-identity/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolRegistry, ToolRegistryRuntimeCapability, IToolExecutor } from '../../foundation/tools/index.js';
import { createContextInjector, type ContextInjector } from './injector.js';
import type { ContractRuntimeLifecycle } from '../contract/index.js';
import type { AsyncTaskRuntimeLifecycle } from '../async-task-system/index.js';
import {
  type RuntimeOptions,
  type TurnResult,
  type PendingTurnFacts,
  type PreparedInboxBatch,
  type PreparedInboxEntry,
  type FormattedInboxBatch,
} from './types.js';
import {
  maybeTrimProactive,
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_PREVIEW_BYTES,
  REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
  buildReactiveTrimPolicy,
  type ContextTrimOutcome,
} from '../context_manager/index.js';
import { trimAndPersist } from '../context_manager/index.js';


import { formatTimeAgo } from './utils.js';

function auditError(
  audit: AuditLog,
  event: string,
  err: unknown,
  ...extras: string[]
): void {
  audit.write(event, ...extras, `reason=${formatErr(err)}`);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => canonicalize(item ?? null));
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) target[key] = canonicalize(source[key]);
  }
  return target;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Phase 1826: 配置身份修订（不透明指纹，不入明文凭据）。
 * Runtime 用它幂等应用 reload：同修订不重复替换 provider/breaker。
 */
function computeConfigRevision(config: LLMOrchestratorConfig): string {
  const identities = [config.primary, ...(config.fallbacks ?? [])].map(c => [
    c.name ?? '',
    c.apiFormat ?? '',
    c.model ?? '',
    c.baseUrl ?? '',
    c.apiKey ? sha256Hex(c.apiKey).slice(0, 8) : '',
  ].join('|'));
  return sha256Hex(identities.join(';')).slice(0, 16);
}

// phase 1406: extractLastTurn 迁出 → foundation/dialog-store/regime-switch.ts（per M#2 业务归属）

/**
 * Runtime - fully assembled Claw runtime instance
 */
export class Runtime {
  protected options: RuntimeOptions;
  protected initialized = false;
  /** phase 522 C2: 防 stop 二次调用重 await 120s task timeout / contract close 二度 */
  private _stopped = false;
  private currentAbortController: AbortController | null = null;
  private turnCount = 0;
  protected auditWriter!: AuditLog;
  /** phase 1343 α-6: current turn-level trace id for cross-module audit correlation */
  private currentTraceId?: TraceId;

  /** Phase 1218 Step A: single active dialog mutation operation join handle */
  private activeDialogOperation: Promise<unknown> | null = null;
  /** Phase 1218 Step A: stop gate — once true, new public operations fail-fast */
  private stopping = false;

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
  /**
   * phase 1860 (RT-D1)：llm 单一存储 = Assembly 注入的完整编排对象（initialize 时自
   * deps.llmOrchestrator 赋值；deps.llm / deps.llmOrchestrator 契约上同一对象）。
   * 不直接访问本字段——经下方两个类型视图消费。
   */
  private _llmImpl!: LLMOrchestrator;
  /**
   * phase 1860 (RT-D1)：Runtime 私有消费面（窄 capability 视图）——仅
   * getProviderInfo / resetLastSuccessProvider / reloadConfig / close 4 方法可编译调用。
   */
  protected get llm(): LLMRuntimeCapability {
    return this._llmImpl;
  }
  protected set llm(value: LLMRuntimeCapability) {
    // Test seam：既有测试以窄 mock poke 本字段；mock 实带 stream/call 宽面、存储保持宽类型。
    this._llmImpl = value as LLMOrchestrator;
  }
  /**
   * phase 1860 (RT-D1)：llm 转发面视图——ExecContext 构造与 runReact 消费的完整编排面；
   * Runtime 不消费、仅传递；与 this.llm 同一底层对象。
   */
  protected get llmOrchestrator(): LLMOrchestrator {
    return this._llmImpl;
  }

  // Core
  protected sessionManager!: DialogSessionLifecycle;
  /**
   * @protected allows create-runtime helper to call buildParts() / customize prompt injection order
   * (phase 266 reframed MotionRuntime subclass to identity-based dispatch; treat as read-only — no injector state mutation)
   */
  protected contextInjector!: ContextInjector;
  /**
   * phase 1860 (RT-D1)：toolRegistry 单一存储。deps.toolRegistry 窄类型声明 Runtime 私有
   * 消费面；Assembly 契约注入对象为完整 ToolRegistry（ExecContext/runReact/identityToolFilter
   * 转发消费宽面），存储保持宽类型。
   */
  private _toolRegistryImpl!: ToolRegistry;
  /**
   * phase 1860 (RT-D1)：Runtime 私有消费面（窄 capability 视图）——仅
   * getForProfile / formatForLLM 2 方法可编译调用。
   */
  protected get toolRegistry(): ToolRegistryRuntimeCapability {
    return this._toolRegistryImpl;
  }
  protected set toolRegistry(value: ToolRegistryRuntimeCapability) {
    // Assembly 契约：注入对象为完整 ToolRegistry；窄类型为消费面纪律（M#7）。
    this._toolRegistryImpl = value as ToolRegistry;
  }
  /**
   * phase 1860 (RT-D1)：toolRegistry 转发面视图——ExecContext 构造、runReact 与
   * identityToolFilter 消费的完整注册表；Runtime 不消费、仅传递；与 this.toolRegistry 同一底层对象。
   */
  protected get toolRegistryForwarding(): ToolRegistry {
    return this._toolRegistryImpl;
  }
  private taskSystem!: AsyncTaskRuntimeLifecycle;
  private contractManager!: ContractRuntimeLifecycle;
  protected execContext!: ExecContext;
  protected toolExecutor!: IToolExecutor;
  private inboxReader!: InboxDeliverySession;
  private snapshot!: SnapshotCommitter;
  // phase 1414: inbox 消息 formatter 注册表（Assembly 装配期填、各业主自家）
  private formatterRegistry!: InboxMessageRenderingResolver;
  // phase 27 Step D P5: guidance compose callback hook
  private guidanceCompose?: import('./types.js').GuidanceCompose;

  // phase 521: regime switch coordination
  private dialogStoreFactory!: () => DialogSessionLifecycle;
  protected lastIdentityHash?: string;  // protected: TestRuntime subclass needs read access for regime switch tests
  // phase 1190：上下文管理器运行时配置（filterSubtypes 已移除）
  private contextTrimmingEnabled: boolean;
  /** Phase 1826: 已应用的配置身份修订（幂等 reload 防重复替换 breaker）。 */
  private appliedConfigRevision?: string;
  /** phase 453：上次 LLM call 完成时刻 (ms epoch)；0 = 从未调用过、第一个 turn 不触发顺手裁 */
  private lastLLMCallAt: number = 0;
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
    this.formatterRegistry = deps.formatterRegistry;   // phase 1414: ctor-time bind（formatInboxMessage 可在 initialize 前调）
    this.guidanceCompose = deps.guidanceCompose;        // phase 27 Step D P5: callback hook
    this.contextTrimmingEnabled = options.contextTrimmingEnabled ?? false;
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

    const deps = this.options.dependencies;

    // 1. 消费 dependencies；claw layout 已由 Assembly 在构造业务模块前初始化。
    this.systemFs = deps.systemFs;
    this.auditWriter = deps.auditWriter;
    // phase 1860 (RT-D1)：llm 单一存储 = deps.llmOrchestrator（Assembly 契约：与 deps.llm
    // 注入同一对象；deps.llm 窄字段 = Runtime 私有消费面的类型级声明）。
    this._llmImpl = deps.llmOrchestrator;
    this.snapshot = deps.snapshot;
    this.sessionManager = deps.sessionManager;
    this.inboxReader = deps.inboxReader;
    try {
      const initResult = await this.inboxReader.init();
      if (initResult.kind === 'degraded') {
        // phase 1781: reconcile 失败显式降级——保留 stage/entry/原始 error 证据，
        // 未恢复 entry 留在 inflight/（不丢不重复处置），下次启动幂等重试；启动继续。
        auditError(
          this.auditWriter,
          RUNTIME_AUDIT_EVENTS.INBOX_INIT_DEGRADED,
          initResult.error,
          `stage=${initResult.stage}`,
          ...(initResult.entry !== undefined ? [`entry=${initResult.entry}`] : []),
          `recovered=${initResult.recovered}`,
        );
      }
    } catch (e) {
      auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.INBOX_INIT_FAILED, e);
      throw e;
    }
    // phase 1414: formatterRegistry 已在 ctor 期初始化（initialize 前可用）
    this.toolRegistry = deps.toolRegistry;
    this.toolExecutor = deps.toolExecutor;
    this.contractManager = deps.contractManager;
    this.taskSystem = deps.taskSystem;
    // phase 1211: ContextInjector + ExecContext 是 Runtime 内部组件（phase 1440: injector 物理迁 runtime/）
    // 用既有 RuntimeDeps 字段自构造、不接受外部 inject
    this.contextInjector = createContextInjector({
      fs: this.systemFs,
      skillRegistry: deps.skillRegistry,
      loadActiveContract: () => this.contractManager.loadActive(),
      audit: this.auditWriter,
    });
    this.execContext = new ExecContextImpl({
      clawId: this.options.clawId,
      clawDir: this.options.clawDir,
      workspaceDir: path.join(this.options.clawDir, CLAWSPACE_DIR),
      syncDir: path.join(this.options.clawDir, TASKS_SYNC_DIR),
      profile: this.options.toolProfile ?? 'full',
      permissionChecker: deps.permissionChecker,  // NEW phase 1273
      fs: this.systemFs,
      fsFactory: this.options.dependencies.fsFactory,
      llm: this.llmOrchestrator,   // phase 1860 (RT-D1)：转发面（非 Runtime 私有消费面）
      auditWriter: this.auditWriter,
      persistReadFileState: true,  // phase 1443: main claw ctx persists readFileState to <clawDir>/read-state.json
      // phase 146: M#3 资源唯一归属真治、直接 read 真 owner、不经 Runtime mirror state
      getCallerSnapshot: async () => {
        const { systemPrompt } = await this._resolveSystemPromptForRun();
        const tools = this.toolRegistry.formatForLLM(
          this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
        );
        const loadResult = await this.sessionManager.load();
        if (loadResult.source === 'io_error') {
          throw new Error(`Session load failed: ${loadResult.error}`);
        }
        const { session } = loadResult;
        return {
          systemPrompt,
          tools,
          messages: session.messages,
        };
      },
      registry: this.toolRegistryForwarding,   // phase 1860 (RT-D1)：转发面（工具执行消费宽面）
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
      await this.taskSystem.startDispatch();
    } catch (e) {
      auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.TASK_SYSTEM_START_DISPATCH_FAILED, e);
      throw new Error(`Runtime: AsyncTaskSystem.startDispatch failed: ${formatErr(e)}`, { cause: e });
    }

    // phase 1406: SummonTool 注册迁出 Runtime → Assembly 标准路径
    // （assemble.ts:251 toolRegistry.register(new SummonTool())）。
    // Runtime 不再反向 import 此 L4 Tool 类，G→F 单向依赖恢复。
    if (this.options.identityToolFilter) {
      this.options.identityToolFilter(this.toolRegistryForwarding);
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
    if (loadResult.source === 'io_error') {
      throw new Error(`Session load failed: ${loadResult.error}`);
    }
    const { session, source } = loadResult;
    // interruptionMessage 由 caller（daemon）传入，runtime 不再直读 audit 文件
    this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SESSION_LOADED, `source=${source}`);
    const { repaired, toolCount } = repairDialogMessages(
      session.messages,
      interruptionMessage ? { interruptionMessage } : undefined,
    );
    if (toolCount > 0) {
      try {
        const repairTools = this.toolRegistry.formatForLLM(
          this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
        );
        const saved = await this.sessionManager.save({
          systemPrompt: session.systemPrompt,
          messages: repaired,
          toolsForLLM: repairTools,
        });
        // phase 1850 Step C: save 不再隐式写 caller 数组——显式回传 blockId
        applyBlockIdAssignments(repaired, saved.assignedBlockIds);
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
   *
   * Phase 1218 Step A: Runtime owns the active dialog operation lifecycle.
   * Stop gate prevents new public operations; we abort the current turn,
   * await the active operation settle, then close downstream dependencies.
   */
  async stop(): Promise<void> {
    // phase 522 C2: 幂等 guard — disassemble 路径 + 测试/异常路径可能重入
    if (this._stopped) return;
    this._stopped = true;
    // Phase 1218 Step A: reject new public operations and abort current turn
    this.stopping = true;
    this.abort();
    // Phase 1218 Step D: await active dialog operation settle before shutting down
    // dependencies that the operation may be using (taskSystem / contractManager / LLM).
    // The original operation promise still propagates its error to its caller;
    // join here is only for shutdown barrier. Failure to join is audited but does
    // not block closing downstream resources (best-effort barrier).
    const active = this.activeDialogOperation;
    if (active) {
      try {
        await active;
      } catch (e) {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_JOIN_FAILED,
          `reason=${formatErr(e)}`,
        );
      }
    }
    const shutdownOutcome = await this.taskSystem.shutdown(120_000);
    // phase 1814 Step B（AT-D3）：穷尽消费 union，不再 if(timedOut) 猜测。
    switch (shutdownOutcome.kind) {
      case 'timed_out': {
        // phase 1332 N4: timeout edge case abort path — ensure tasks are killed before llm.close
        // 防 phase 1286 100M tokens cascade 后 task 长跑 1-2min / 子代理资源继承
        this.taskSystem.abort();
        this.auditWriter.write(
          TASK_AUDIT_EVENTS.TASK_SHUTDOWN_TIMEOUT_HIT,
          `timeout_ms=120000`,
          `pending=${shutdownOutcome.pending.join(',')}`,
        );
        break;
      }
      case 'converged':
      case 'already_shutting_down':
        // 已收敛（或重入幂等、由首个 shutdown 负责收敛）→ 无超时路径动作。
        break;
    }
    // phase 324 H5: 关 ContractSystem、abort 仍活的 verifier AbortController 串、
    // await 其 termination promise。否则 SIGTERM 留 verifier LLM stream 泄漏
    // —— 正是 phase 1332 N4 + close() 引入要防的。
    await this.contractManager.close().catch(() => {
      /* close error 已 audit emit / barrier 不阻塞 stop */
    });
    await this.llm.close();
  }

  /**
   * Phase 1218 Step A: non-queuing dialog mutation operation guard.
   *
   * - Rejects new operations while stopping.
   * - Rejects concurrent public operations (fail-fast + audit).
   * - Stores the derived join handle so stop() can await the active operation.
   * - Caller still awaits the original promise and receives its original error.
   */
  private async _withDialogOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) {
      this.auditWriter.write(RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_WHILE_STOPPING);
      throw new Error('Runtime is stopping');
    }
    if (this.activeDialogOperation) {
      this.auditWriter.write(RUNTIME_AUDIT_EVENTS.DIALOG_OPERATION_CONCURRENT);
      throw new Error('Concurrent dialog operation detected');
    }
    const promise = operation();
    this.activeDialogOperation = promise;
    try {
      return await promise;
    } finally {
      if (this.activeDialogOperation === promise) {
        this.activeDialogOperation = null;
      }
    }
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
   * 各 owner 的 formatter declaration 由 Assembly 注册，Runtime 只按 type resolve。
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

    const rendering = this.formatterRegistry.resolve(type);
    let formatted: string;
    if (!rendering) {
      // DP 不静默：未注册 type 必 audit + 走默 fallback（不丢消息）
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_UNKNOWN_TYPE,
        `type=${type}`,
        `from=${from}`,
      );
      formatted = renderStandardInboxMessage({ from, body, timestampSec: t }, 'system');
    } else if (rendering.kind === 'standard') {
      formatted = renderStandardInboxMessage({ from, body, timestampSec: t }, rendering.presentation);
    } else {
      formatted = await rendering.formatter({ from, body, timestampSec: t });
    }

    // phase 27 Step D P5: motion-side append guidance（motion 装配 guidanceCompose 必持 / claw undefined → 跳）
    if (this.guidanceCompose) {
      try {
        // phase 1256 Step A: 唯一 envelope 构造点 — type/from/meta 一次性交给 Assembly、不丢 from
        const g = this.guidanceCompose({ type, from, meta: extraMeta ?? {} });
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
    // phase 1847: 旧组合入口 = prepareInbox → formatPreparedInbox。
    // format 拒绝时本批句柄尚未交接调用方 → Runtime 负责回队（不吞失败、
    // 不返回空结果），再向 caller 重抛原 error。
    const prepared = await this.prepareInbox();
    let formatted: FormattedInboxBatch;
    try {
      formatted = await this.formatPreparedInbox(prepared);
    } catch (error) {
      await this.nackHandles(
        prepared.entries.map(e => e.handle),
        formatErr(error),
        'inbox_format_failure',
      );
      throw error;
    }
    return {
      injected: formatted.injected,
      sources: formatted.sources,
      count: formatted.count,
      infos: formatted.infos,
      addressedHandles: prepared.entries.map(e => e.handle),
    };
  }

  /**
   * Phase 1847: 原始消息准备 —— 只领取（pending→inflight）与分流，不格式化、
   * 不生成注入数据、不发 INBOX_INJECT、不 ack/nack 普通消息。
   *
   * 返回的 addressed 消息/句柄自此归调用方处置；格式化是可失败的后续动作
   * （见 formatPreparedInbox）。分流规则与旧组合入口一致：
   * - reload 控制消息沿 _handleReloadEntries 应用配置并 ack（句柄所有权转控制处理）；
   * - 误路由（to=其他 claw）沿 Messaging.markMisrouted（句柄所有权转误路由分支）；
   * - 控制句柄只属于控制处理，不再能被误路由集合选中（按非 reload 集合拆分）。
   *
   * entry↔handle 按 filePath 关联（不按消息 ID：历史 ID 可重复；不假设两个数组
   * 索引永远一致）。合法 entry 缺对应 handle 视为编排错误（不伪造 branded handle），
   * 进入准备失败处置。
   *
   * 准备失败处置：取得 handle 后、交给调用方前若发生未被既有分支处理的异常，
   * 对尚未转交控制/误路由分支的普通句柄 nackHandles(..., 'inbox_prepare_failure')
   * 后重抛原 error；已转交分支的句柄不重复 nack/误路由（其逐项失败留证行为保持）。
   */
  async prepareInbox(): Promise<PreparedInboxBatch> {
    const { entries, handles, transientErrors, permanentErrors } = await this._drainEntriesOrEmpty();
    if (transientErrors > 0 || permanentErrors > 0) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_DRAIN_ERRORS,
        `transient=${transientErrors}`,
        `permanent=${permanentErrors}`,
      );
    }
    if (entries.length === 0) {
      return { entries: [] };
    }

    // 普通（非 reload）句柄：交接调用方/误路由分支前归 Runtime 所有。
    const nonReloadPaths = new Set(
      entries.filter(e => e.message.type !== RELOAD_LLM_CONFIG_MESSAGE_TYPE).map(e => e.filePath),
    );
    const ownedHandles = new Set(handles.filter(h => nonReloadPaths.has(h.filePath)));
    try {
      // phase 320: hot-reload 拦截 — reload_llm_config 旁路、不入 AI 上下文、不入 turn lifecycle。
      // 调用后控制句柄所有权转控制处理（不在 ownedHandles 集合内，不会再被 nack/误路由）。
      const reloadEntries = entries.filter(e => e.message.type === RELOAD_LLM_CONFIG_MESSAGE_TYPE);
      const nonReloadEntries = entries.filter(e => e.message.type !== RELOAD_LLM_CONFIG_MESSAGE_TYPE);
      if (reloadEntries.length > 0) {
        await this._handleReloadEntries(reloadEntries, handles);
      }
      if (nonReloadEntries.length === 0) {
        return { entries: [] };
      }

      const handleByPath = new Map(handles.map(h => [h.filePath, h]));
      const { addressed } = this._splitAndAuditEntries(nonReloadEntries);

      // phase 442 (review N3-C-H1 / R2-C-N1): unaddressed (to=<other_claw>) 消息
      // 移到 misrouted/ 隔离、不 ack 到 done/。句柄自此转误路由分支（markMisrouted
      // 内部逐项失败已发 INBOX_MOVE_FAILED audit），不再归 Runtime 回队责任。
      const addressedPaths = new Set(addressed.map(e => e.filePath));
      for (const h of [...ownedHandles]) {
        if (addressedPaths.has(h.filePath)) continue;
        ownedHandles.delete(h);
        try {
          await this.inboxReader.markMisrouted(h);
        } catch (e) {
          // best-effort; markMisrouted 内已发 INBOX_MOVE_FAILED(op=misrouted) audit
        }
      }

      const prepared: PreparedInboxEntry[] = [];
      for (const entry of addressed) {
        const handle = handleByPath.get(entry.filePath);
        if (!handle) {
          // 编排错误：drainAndDeliver 承诺 entry↔handle 成对；缺 handle 不伪造、
          // 未转交句柄走准备失败处置回队。
          throw new Error(
            `Runtime.prepareInbox: claimed entry has no delivery handle: ${entry.filePath}`,
          );
        }
        prepared.push({ message: entry.message, handle });
      }
      return { entries: prepared };
    } catch (error) {
      // 未被既有分支处理的异常：仍归 Runtime 的普通句柄回队，重抛原 error。
      // 不是 finally 无条件 nack —— 成功交付批次/已转交分支不受影响。
      await this.nackHandles([...ownedHandles], formatErr(error), 'inbox_prepare_failure');
      throw error;
    }
  }

  /**
   * Phase 1847: 已领取批次的格式化 —— 输入仅是 prepared.entries，不调用 reader、
   * 不查目录、不结算。这是通用格式化边界，不是契约判定/业务筛选入口。
   *
   * 每项成功格式化后发原 INBOX_INJECT 列（格式化交付记录，不是 LLM 已执行的证明）；
   * file 使用 handle.originalFileName（等价 basename 原路径）、trace_id 规则保持。
   * 任一 formatter 拒绝向调用者抛原 error：批次整体交给调用者回队，不返回不完整
   * injected 伪装成功（已格式化的文本未发给 LLM）。
   */
  async formatPreparedInbox(batch: PreparedInboxBatch): Promise<FormattedInboxBatch> {
    const injected: Message[] = [];
    const sources: Array<{ text: string; type: string }> = [];
    const infos: InboxMessage[] = [];
    const now = new Date().toISOString();
    const traceCol = `trace_id=${String(this.execContext?.trace_id ?? '')}`;
    for (const { message, handle } of batch.entries) {
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
      infos.push(message);
      // phase 1847: 审计时点迁到单项格式化成功之后（phase 565 forensic 列保持）
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_INJECT,
        `file=${handle.originalFileName}`,
        `type=${message.extraMeta?.__original_type ?? message.type}`,
        `from=${message.from}`,
        `to=${message.to || this.options.clawId}`,
        `pri=${message.priority}`,
        traceCol,
      );
    }
    return { injected, sources, count: batch.entries.length, infos };
  }

  /**
   * phase 320: 处理 reload_llm_config 拦截消息。
   * - 同批 N 条只 reload 1 次（idempotent / 都读最新磁盘）
   * - reload 消息无视 to 字段（reload 是「daemon 自家配置」、to 无意义）
   * - 所有 reload 消息一律 ack（成功 / 失败 / skipped 都已消费、不留在 inflight）
   */
  /**
   * Phase 1826: 应用磁盘上的最新 LLM 配置，返回配置身份修订。
   * - 重复 revision 不重复 reloadConfig（防二次重载清空 breaker 失败历史）。
   * - 失败以 audit 暴露并返回 undefined（调用方不据此放行新的尝试）。
   */
  private _applyConfigReload(triggeredBy: number): string | undefined {
    if (!this.options.configReloader) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.LLM_RELOAD_SKIPPED,
        `count=${triggeredBy}`,
        `reason=no_reloader_configured`,
      );
      return undefined;
    }
    try {
      const newConfig = this.options.configReloader();
      const revision = computeConfigRevision(newConfig);
      if (revision === this.appliedConfigRevision) {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.LLM_RELOAD_SKIPPED,
          `count=${triggeredBy}`,
          `reason=already_applied`,
          `revision=${revision}`,
        );
        return revision;
      }
      this.llm.reloadConfig(newConfig);
      this.appliedConfigRevision = revision;
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.LLM_RELOADED,
        `provider=${newConfig.primary.name ?? 'unknown'}`,
        `fallbacks=${newConfig.fallbacks?.length ?? 0}`,
        `triggered_by=${triggeredBy}`,
        `revision=${revision}`,
      );
      return revision;
    } catch (err) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.LLM_RELOAD_FAILED,
        `reason=${formatErr(err)}`,
      );
      return undefined;
    }
  }

  private async _handleReloadEntries(reloadEntries: InboxEntry[], handles: InboxHandle[]): Promise<void> {
    const reloadPaths = new Set(reloadEntries.map(e => e.filePath));
    const reloadHandles = handles.filter(h => reloadPaths.has(h.filePath));

    this._applyConfigReload(reloadEntries.length);

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

  private async _drainEntriesOrEmpty(): Promise<InboxDeliveryBatch> {
    // phase 1782: claim/move 首个失败以 typed partial_failure 返回（不再以异常穿越
    // drain 边界、不再把 partial batch 压平为完整成功）。audit 保留停止原因 evidence；
    // 已 claim entries/handles 照常交付，未处理 entries 留 pending/ 下轮幂等重试。
    const result = await this.inboxReader.drainAndDeliver();
    if (result.kind === 'partial_failure') {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_DRAIN_FAILED,
        `stage=${result.stage}`,
        `entry=${result.entry ?? ''}`,
        `delivered=${result.entries.length}`,
        // phase 567: 加 trace_id forensic field（optional chain 兜底 init 调用路径）
        `error=${result.error instanceof Error ? result.error.constructor.name : 'unknown'}`,
        `reason=${formatErr(result.error)}`,
        `trace_id=${String(this.execContext?.trace_id ?? '')}`,
      );
    }
    return result;
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
    // phase 1847: addressed 的 INBOX_INJECT 迁到 formatPreparedInbox 单项格式化
    // 成功后发（准备阶段只分流，不发格式化交付记录）。
    const traceCol = `trace_id=${String(this.execContext?.trace_id ?? '')}`;
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
  protected async _runReact(messages: Message[], systemPrompt: string, tools: ToolDefinition[], callbacks?: RuntimeTurnCallbacks): Promise<void> {
    // phase 786: stopRequested 是 per-turn flag，每 turn 起首 reset
    // 防 P0.14 跨 turn sticky bug（done 工具误调后下 turn silent empty）
    this.execContext.stopRequested = false;
    // 解析一次 regime/identity 信息；LLM 仍使用 caller 传入的 systemPrompt。
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
        llm: this.llmOrchestrator,   // phase 1860 (RT-D1)：转发面（AgentExecutor 消费宽面）
        executor: this.toolExecutor,
        ctx: this.execContext,
        tools,
        registry: this.toolRegistryForwarding,  // phase 1860 (RT-D1)：转发面（parallel readonly 执行消费）
        maxSteps: this.options.maxSteps,
        maxConsecutiveParseErrors: this.options.maxConsecutiveParseErrors,
        maxConsecutiveMaxTokensToolUse: this.options.maxConsecutiveMaxTokensToolUse,
        idleTimeoutMs: this.options.idleTimeoutMs,
        auditWriter: this.auditWriter,
        currentContractId,
        // phase 1856 (AE-D9): AgentExecutor-owned 结构化事件经 caller adapter 绑定
        // contract_id/trace_id 并格式化为审计行（行内容与原循环内直写逐列一致）。
        eventSink: createAgentExecutorAuditSink({
          auditWriter: this.auditWriter,
          currentContractId,
          execContext: this.execContext,
        }),
        stepCallbacks: {
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
        onTextDelta: (d) => { emitProviderInfoOnce(); callbacks?.onTextDelta?.(d); },
        onTextEnd: callbacks?.onTextEnd,
        onThinkingDelta: (d) => { emitProviderInfoOnce(); callbacks?.onThinkingDelta?.(d); },
        onToolCall: callbacks?.onToolCall,
        // phase 688: API 收到的 args body 落 stream.jsonl（daemon callback 已实现 onToolUseInput、此处仅透传）
        // 与 onToolCallInput（audit-only size index）互补、不重复 audit。
        onToolUseInput: callbacks?.onToolUseInput,
        onToolUseInputDelta: callbacks?.onToolUseInputDelta,
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
        },
        onStepComplete: async (stepCount) => {
          // phase 1860 (RT-D2)：step 提交经单一编排协议（dialog save → blockId 回写 → read-state persist）。
          await this._commitStepBoundary(systemPrompt, messages, tools);
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

        streamCallbacks: callbacks,
      });
      // phase 1860 (RT-D2)：turn 尾提交经同一编排协议；read-state 已由最后 step persist、
      // 不重复提交（保持原 turn 尾语义）。
      await this._commitStepBoundary(systemPrompt, messages, tools, { persistReadState: false });

      // phase 521: turn 末 regime change 检测（per L5.G3 (a) 自动检测）
      await this._checkRegimeSwitch(resolvedSystemPrompt, identityContent);
    } finally {
      // phase 146: mirror state removed — no reset needed
    }
  }

  /**
   * phase 1860 (RT-D2)：单一提交编排协议——定点序 DialogStore.save → blockId 回写 →
   * FileTool read-state persist；step 边界（onStepComplete）与 turn 结束后统一经此，
   * 禁止在本方法外重排提交序。
   *
   * phase 1850 Step C: save 不隐式写 caller 数组——blockId 经 applyBlockIdAssignments 显式回传。
   * Phase 1229 Step A: FileTool owns the entry/schema and persistence primitive;
   * Runtime owns the boundary timing. Order is fixed: dialog → read-state.
   *
   * @param opts.persistReadState 默认 true（step 边界）；turn 尾传 false——read-state 已由
   *   最后 step persist，turn 尾不重复提交（保持 phase1860 前 turn 尾原语义）。
   */
  private async _commitStepBoundary(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    opts?: { persistReadState?: boolean },
  ): Promise<void> {
    const saved = await this.sessionManager.save({
      systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId,
    });
    applyBlockIdAssignments(messages, saved.assignedBlockIds);
    if (opts?.persistReadState !== false) {
      await persistReadFileState(this.execContext);
    }
  }

  /** Persist one forensic boundary for every completed turn disposition. */
  private async _commitTurnSnapshot(outcome: TurnResult['status']): Promise<void> {
    this.turnCount++;
    const context = `turn-${this.turnCount}`;
    const traceCol = `trace_id=${String(this.execContext?.trace_id ?? '')}`;
    const commitResult = await this.snapshot
      .commit(`${context} outcome=${outcome} ${new Date().toISOString()}`)
      .catch((err: unknown): null => {
        auditError(
          this.auditWriter,
          RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED,
          err,
          `context=${context}`,
          `outcome=${outcome}`,
          traceCol,
        );
        return null;
      });
    if (commitResult && !commitResult.ok) {
      if (commitResult.error.kind === 'uncategorized') {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED,
          `context=${context}`,
          `outcome=${outcome}`,
          `exitCode=${commitResult.error.exitCode}`,
          traceCol,
        );
      } else {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED,
          `context=${context}`,
          `outcome=${outcome}`,
          `kind=${commitResult.error.kind}`,
          traceCol,
        );
      }
    }
  }

  /**
   * Phase 1158 Step B: 安全 rollback，保留 original 与 recovery error 双因果。
   */
  private async _rollbackFailedTurn(original: unknown): Promise<TurnResult> {
    try {
      await this.sessionManager.rollbackTurn(formatErr(original));
      return { status: 'failed', error: original };
    } catch (rollbackError) {
      return {
        status: 'failed',
        error: new AggregateError(
          [original, rollbackError],
          'Turn failed and dialog rollback also failed',
          { cause: original },
        ),
      };
    }
  }

  /**
   * Execute a single ReAct turn for the given messages.
   * Orchestration-free: callers decide drain/trim/ack/nack/retry policy.
   *
   * Phase 1158 Step B: transaction 全路径（begin/save/react/commit/rollback）
   * 失败均 resolve 为 TurnResult，不再因 transaction error reject。
   *
   * Phase 1218 Step A: public entry guarded by _withDialogOperation.
   */
  async processTurn(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
    callbacks?: RuntimeTurnCallbacks,
    reuseTraceId?: TraceId,
  ): Promise<TurnResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    return this._withDialogOperation(() => this._processTurnImpl(messages, systemPrompt, toolsForLLM, callbacks, reuseTraceId));
  }

  /**
   * Phase 1218 Step A: internal turn implementation. Must only be invoked
   * inside the public processTurn entry's active _withDialogOperation guard.
   */
  private async _processTurnImpl(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
    callbacks?: RuntimeTurnCallbacks,
    reuseTraceId?: TraceId,
  ): Promise<TurnResult> {
    const { cleanup } = this._setupTurnContext(reuseTraceId);
    let outcome: TurnResult['status'] = 'failed';
    try {
      // phase 569: 加 trace_id forensic field（turn 入口 trace_id 已设）
      // phase 722: 加 caller col 区分 processTurn caller 路径
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START, `caller=processTurn`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);

      try {
        await this.sessionManager.beginTurn();
        const saved = await this.sessionManager.save({
          systemPrompt,
          messages,
          toolsForLLM,
          trace_id: this.currentTraceId,
        });
        // phase 1850 Step C: save 不再隐式写 caller 数组——显式回传 blockId
        applyBlockIdAssignments(messages, saved.assignedBlockIds);

        // 新 turn 开始 → 重置 lastSuccessProvider，让本 turn 第一步从 primary 开始挑 model
        this.llm.resetLastSuccessProvider?.();

        await this._runReact(messages, systemPrompt, toolsForLLM, callbacks);

        callbacks?.onTurnEnd?.();
        // phase 569: 加 trace_id forensic field
        // phase 722: 加 caller col 区分 processTurn caller 路径
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END, `caller=processTurn`, `trace_id=${String(this.execContext?.trace_id ?? '')}`);
        await this.sessionManager.commitTurn();
        outcome = 'success';
        return { status: 'success' };
      } catch (error) {
        handleTurnInterrupt(error, this.auditWriter, callbacks, this.execContext?.trace_id ? String(this.execContext.trace_id) : undefined);
        if (error instanceof PriorityInboxInterrupt
            || error instanceof UserInterrupt
            || error instanceof IdleTimeoutSignal) {
          const cause = error instanceof PriorityInboxInterrupt ? 'priority_inbox'
                       : error instanceof UserInterrupt          ? 'user_interrupt'
                       :                                         'idle_timeout';
          try {
            await this.sessionManager.commitTurn(cause);
            outcome = 'interrupted';
            return { status: 'interrupted', error, cause };
          } catch (commitError) {
            return this._rollbackFailedTurn(
              new AggregateError([error, commitError], 'Interrupted turn commit failed', { cause: error }),
            );
          }
        }
        return this._rollbackFailedTurn(error);
      }
    } finally {
      try {
        await this._commitTurnSnapshot(outcome);
      } finally {
        cleanup();
      }
    }
  }
  // P1-10: retryLastTurn 方法已删除。rollback-first 流程下其「截断到 lastUserIdx 重放」
  // 语义必然命中上一轮成功 turn，导致非幂等副作用重复执行；删除后 LLM 类失败重试走
  // rollback + nack + 退避 → re-drain 全新 turn。

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
    const loadResult = await this.sessionManager.load();
    if (loadResult.source === 'io_error') {
      throw new Error(`Session load failed: ${loadResult.error}`);
    }
    const { session } = loadResult;
    return session.messages;
  }

  /**
   * Phase 1153 Step C: read a stable, non-consuming view of pending inbox facts.
   * Controls (reload_llm_config) are included in the fingerprint because they can
   * change provider configuration and therefore must unblock a gated claw.
   */
  /**
   * Phase 1826: 尚未处理的用户干预身份（用户来源消息 id 列表）。
   * EventLoop 只用不透明 id 向 owner 请求准入；正文仍在正常 drain 进入上下文。
   */
  async peekPendingInterventionFacts(): Promise<{ userIds: string[] }> {
    if (!this.inboxReader) {
      throw new Error('Runtime not initialized: inboxReader unavailable');
    }
    const view = await this.inboxReader.peekPending();
    const userIds = view.entries
      .filter(e => e.message.type === 'user_chat' || e.message.type === 'user_inbox_message')
      .filter(e => !e.message.to || e.message.to === this.options.clawId)
      .map(e => e.message.id);
    return { userIds };
  }

  /**
   * Phase 1826: 等待期间的 Runtime 控制入口。
   * 应用磁盘上的最新 LLM 配置并返回配置身份修订；不 claim/ack 消息（仍留在
   * pending，由正常 drain 消费一次），也不搬动普通消息。
   */
  async consumePendingControls(): Promise<{ consumed: number; configRevision?: string }> {
    if (!this.inboxReader) {
      throw new Error('Runtime not initialized: inboxReader unavailable');
    }
    const view = await this.inboxReader.peekPending();
    const controls = view.entries.filter(e => e.message.type === RELOAD_LLM_CONFIG_MESSAGE_TYPE);
    if (controls.length === 0) return { consumed: 0 };
    const revision = this._applyConfigReload(controls.length);
    return {
      consumed: controls.length,
      ...(revision !== undefined ? { configRevision: revision } : {}),
    };
  }

  async peekPendingTurnFacts(): Promise<PendingTurnFacts> {
    if (!this.inboxReader) {
      throw new Error('Runtime not initialized: inboxReader unavailable');
    }
    const view = await this.inboxReader.peekPending();
    const controls = view.entries
      .filter(e => e.message.type === RELOAD_LLM_CONFIG_MESSAGE_TYPE)
      .map(e => e.message);
    const addressed = view.entries
      .filter(e => e.message.type !== RELOAD_LLM_CONFIG_MESSAGE_TYPE)
      .filter(e => !e.message.to || e.message.to === this.options.clawId)
      .map(e => e.message);
    return { addressed, controls };
  }

  /**
   * Phase 1153 Step C: canonical SHA-256 fingerprint of the request that would be
   * sent to the LLM if drain/processing proceeded now. Any material change to
   * session, system prompt, tools, pending addressed messages, controls, provider,
   * or trim policy changes the fingerprint and releases a blocked state.
   */
  async computeTurnRequestFingerprint(): Promise<string> {
    const providerInfo = this.llm.getProviderInfo?.();
    const primary = this.options.llmConfig.primary;
    const facts = {
      version: 1,
      sessionMessages: await this.getMessages(),
      systemPrompt: await this.getSystemPrompt(),
      tools: this.getToolsForLLM(),
      pending: await this.peekPendingTurnFacts(),
      provider: {
        name: providerInfo?.name ?? primary.name,
        model: providerInfo?.model ?? primary.model,
        contextWindow: resolveContextWindow(providerInfo?.model ?? primary.model),
        explicitMaxTokens: primary.maxTokens ?? 0,
      },
      trimPolicy: {
        recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
        retentionFloorRatio: REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
        previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
      },
    };
    return sha256Hex(canonicalJson(facts));
  }

  /**
   * Public proactive context trim before a turn; returns the (possibly trimmed) messages.
   *
   * Phase 1218 Step D: this is a public mutation operation and must acquire the
   * dialog operation authority.
   */
  async proactiveTrimIfNeeded(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
  ): Promise<Message[]> {
    return this._withDialogOperation(() =>
      this._proactiveTrimIfNeededImpl(messages, systemPrompt, toolsForLLM),
    );
  }

  /** Phase 1218 Step D: internal proactive trim implementation. */
  private async _proactiveTrimIfNeededImpl(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
  ): Promise<Message[]> {
    if (!this.contextTrimmingEnabled || !this.sessionManager) {
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
      dialogStore: this.sessionManager,
      audit: this.auditWriter,
    });
    return trimResult ? trimResult.newMessages : messages;
  }

  /**
   * Reactive context trim for the current session; returns stable outcome for EventLoop routing.
   *
   * Phase 1218 Step A: this is an independent public mutation operation and must
   * acquire the dialog operation authority.
   */
  async reactiveTrim(): Promise<ContextTrimOutcome> {
    return this._withDialogOperation(() => this._reactiveTrimImpl());
  }

  /** Phase 1218 Step A: internal reactive trim implementation. */
  private async _reactiveTrimImpl(): Promise<ContextTrimOutcome> {
    if (!this.contextTrimmingEnabled || !this.sessionManager) {
      return {
        status: 'no_progress',
        before: 0,
        after: 0,
        reason: 'already_within_target',
        newMessages: [],
        archived: false,
      };
    }
    const loadResult = await this.sessionManager.load();
    if (loadResult.source === 'io_error') {
      throw new Error(`Session load failed: ${loadResult.error}`);
    }
    const { session } = loadResult;
    const tools = this.getToolsForLLM();
    const providerInfo = this.llm.getProviderInfo?.();
    const contextWindow = resolveContextWindow(providerInfo?.model);
    this.auditWriter.write(
      RUNTIME_AUDIT_EVENTS.REACTIVE_TRIM_TRIGGERED,
      `provider=${providerInfo?.name ?? 'unknown'}`,
      `trace_id=${String(this.execContext?.trace_id ?? '')}`,
    );
    const outcome = await trimAndPersist({
      messages: session.messages,
      systemPrompt: session.systemPrompt,
      toolsForLLM: tools,
      contextWindow,
      recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
      previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
      dialogStore: this.sessionManager,
      audit: this.auditWriter,
      triggerKind: 'reactive_overflow',
      policy: buildReactiveTrimPolicy({
        contextWindow,
        explicitMaxTokens: this.options.llmConfig.primary.maxTokens,
      }),
    });
    if (outcome.status === 'no_progress' || outcome.status === 'policy_conflict') {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.REACTIVE_TRIM_EXHAUSTED,
        `provider=${providerInfo?.name ?? 'unknown'}`,
        `trace_id=${String(this.execContext?.trace_id ?? '')}`,
        `status=${outcome.status}`,
        `reason=${outcome.reason}`,
      );
    }
    return outcome;
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
        await this._performRegimeSwitch(newSystemPrompt);   // 仅 switch 语义
        this.lastIdentityHash = identityContent;            // 提交判定先落
      } catch (err) {
        // phase 573: 加 trace_id forensic field（_checkRegimeSwitch 由 turn 末调、trace_id 已设）
        auditError(this.auditWriter, DIALOG_AUDIT_EVENTS.REGIME_SWITCH_FAILED, err, `trace_id=${String(this.execContext?.trace_id ?? '')}`);
        // lastIdentityHash 不更新 → 下 turn 重试自愈（D7）
        return;
      }
      // post-commit 清理（phase 1443 语义保留）：gate state 随 dialog 上下文清除。
      // 时序理由：清理失败不得回溯提交判定，否则已提交切换会被重复执行。
      // 失败由 clearReadFileState 内部审计（READ_FILE_STATE_PERSIST_FAILED op=clear）。
      await clearReadFileState(this.execContext);
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
      systemFs: this.systemFs,
      audit: this.auditWriter,
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
  callbacks?: RuntimeTurnCallbacks,
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
