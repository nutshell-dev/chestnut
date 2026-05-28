/**
 * Runtime - assembles all modules into a runnable Claw instance
 *
 * Final assembly layer integrating L1-L4 modules into runnable Claw instance.
 * 详 design/architecture.md + design/modules/l5_runtime.md。
 */

import * as path from 'path';
import * as crypto from 'node:crypto';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CALLER_TYPE_TO_GROUPS } from '../caller-types.js';

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/types.js';
import type { Message } from '../../foundation/llm-provider/types.js';
import type { InboxMessage } from '../../foundation/messaging/types.js';
import { InboxListFailed, InboxMoveFailed } from '../../foundation/messaging/index.js';

import { DialogStore } from '../../foundation/dialog-store/index.js';
import { SummonTool } from '../summon-system/index.js';
import { runReact } from '../agent-executor/index.js';
import { summarizeLastExit } from './last-exit-summary.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../signals.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import { RUNTIME_AUDIT_EVENTS, REACT_LOOP_AUDIT_EVENTS } from './runtime-audit-events.js';
import { TASK_AUDIT_EVENTS } from '../async-task-system/audit-events.js';
import { HEARTBEAT_AUDIT_EVENTS } from './heartbeat-audit-events.js';
import { CLAW_SUBDIRS } from '../../foundation/paths.js';
import { DIALOG_DIR } from '../../foundation/dialog-store/dirs.js';
import { oneLine, formatErr } from '../../foundation/utils/format.js';
import { escapeForLog } from '../../foundation/tools/index.js';
import { MaxStepsExceededError } from '../agent-executor/index.js';
import { DEFAULT_MAX_STEPS } from '../agent-executor/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Snapshot } from '../../foundation/snapshot/index.js';
import type { InboxReader, InboxEntry, InboxHandle, OutboxWriter } from '../../foundation/messaging/index.js';
import { ExecContextImpl } from '../../foundation/tools/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolRegistry, IToolExecutor } from '../../foundation/tools/index.js';
import { createContextInjector, type ContextInjector } from '../dialog/index.js';
import type { ContractSystem } from '../contract/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import {
  type RuntimeOptions,
  type StreamCallbacks,
  type DaemonStreamCallbacks,
} from './types.js';
import { TASKS_SYNC_DIR } from '../async-task-system/index.js';

import { formatTimeAgo } from './utils.js';
import type { ClawId } from '../../foundation/identity/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import { type ClawDir } from '../../foundation/identity/index.js';



function auditError(
  audit: AuditLog,
  event: string,
  err: unknown,
  ...extras: string[]
): void {
  audit.write(event, ...extras, `reason=${formatErr(err)}`);
}

/** phase 521: 'last-turn' regime switch helper / 找最近 'user' role msg / 从那里切片 */
function extractLastTurn(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages.slice(i);
  }
  return messages; // 0 user msg / 全继承
}

/**
 * Runtime - fully assembled Claw runtime instance
 */
export class Runtime {
  protected options: RuntimeOptions;
  protected initialized = false;
  private currentAbortController: AbortController | null = null;
  private turnCount = 0;
  protected auditWriter!: AuditLog;
  /** phase 1343 α-6: current turn-level trace id for cross-module audit correlation */
  private currentTraceId?: string;

  // Turn state — stored on Runtime (not ExecContext) so L4 modules can
  // access current turn snapshot via getter callback without L2 knowing L4 semantics.
  private _currentSystemPrompt?: string;
  private _currentTools?: import('../../foundation/llm-provider/types.js').ToolDefinition[];
  private _currentMessages?: import('../../foundation/llm-provider/types.js').Message[];

  /** phase 1343 α-6: expose current trace id for daemon-loop stream callbacks */
  getCurrentTraceId(): string | undefined { return this.currentTraceId; }
  /** Current turn system prompt (set by _runReact, cleared after turn) */
  getCurrentSystemPrompt(): string | undefined { return this._currentSystemPrompt; }
  /** Current turn tool definitions (set by _runReact) */
  getCurrentTools(): import('../../foundation/llm-provider/types.js').ToolDefinition[] | undefined { return this._currentTools; }
  /** Current turn messages (set by _runReact, cleared after turn) */
  getCurrentMessages(): import('../../foundation/llm-provider/types.js').Message[] | undefined { return this._currentMessages; }

  // Foundation
  /**
   * @protected allows subclasses such as MotionRuntime to read system files (SOUL.md, etc.)
   * Note: subclasses should not write directly; preserve runtime encapsulation
   */
  protected systemFs!: FileSystem;  // used by system components (no permission check)
  protected llm!: LLMOrchestrator;

  // Core
  protected sessionManager!: DialogStore;
  /**
   * @protected allows subclasses such as MotionRuntime to call buildParts() to customize prompt injection order
   * Note: subclasses should treat this as read-only and must not modify injector state
   */
  protected contextInjector!: ContextInjector;
  protected toolRegistry!: ToolRegistry;
  private taskSystem!: AsyncTaskSystem;
  private contractManager!: ContractSystem;
  protected execContext!: ExecContext;
  protected toolExecutor!: IToolExecutor;
  private inboxReader!: InboxReader;
  private outboxWriter!: OutboxWriter;
  private snapshot!: Snapshot;

  // phase 521: regime switch coordination
  private dialogStoreFactory!: () => DialogStore;
  protected lastIdentityHash?: string;  // protected: TestRuntime subclass needs read access for regime switch tests

  constructor(options: RuntimeOptions) {
    this.options = {
      maxSteps: DEFAULT_MAX_STEPS,
      toolProfile: 'full',
      ...options,
    };
    // auditWriter now comes from dependencies (phase155B+)
    this.auditWriter = options.dependencies.auditWriter;
    const deps = options.dependencies;
    this.dialogStoreFactory = deps.dialogStoreFactory;
    if (deps.parentStreamLog) {
      deps.taskSystem.setParentStreamLog(deps.parentStreamLog);
    }
    if (deps.contractNotifyCallback) {
      deps.contractManager.setOnNotify(deps.contractNotifyCallback);
    }
  }

  /** phase 1343 α-6: set/clear turn-level trace id on audit writer */
  private setTraceId(traceId: string | undefined): void {
    this.currentTraceId = traceId;
    const aw = this.auditWriter as unknown as { traceId?: string };
    if (aw) aw.traceId = traceId;
  }

  /**
   * Initialize all modules
   */
  async initialize(): Promise<void> {
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
      clawforumRoot: this.options.clawforumRoot,
      syncDir: path.join(this.options.clawDir, TASKS_SYNC_DIR),
      profile: this.options.toolProfile ?? 'full',
      allowedGroups: CALLER_TYPE_TO_GROUPS[this.options.systemPromptBuilder ? 'motion' : 'claw'], // caller='motion' index
      callerLabel: this.options.systemPromptBuilder ? MOTION_CLAW_ID : 'claw',
      permissionChecker: deps.permissionChecker,  // NEW phase 1273
      fs: this.systemFs,
      fsFactory: this.options.dependencies.fsFactory,
      llm: this.llm,
      maxSteps: this.options.maxSteps ?? DEFAULT_MAX_STEPS,
      auditWriter: this.auditWriter,
      taskSystem: this.taskSystem,
    });

    // phase 766: inject registry into execContext for sync spawn path
    (this.execContext as { registry?: unknown }).registry = this.toolRegistry;
    // phase 768: inject mainDialogStore into main agent execContext.
    (this.execContext as { mainDialogStore?: DialogStore }).mainDialogStore = this.sessionManager;

    // 3. Session repair（业务链路）
    //    先 load 再 archive：直接读 current.json 恢复，避免不必要的归档恢复中转。
    //    archive 在 load 成功之后作旁路安全备份——数据已在内存中，归档只是 trail。
    await this.repairSessionIfNeeded();

    // 4. 归档 session 为旁路备份（first-run ENOENT 允许）
    await this.sessionManager.archive().catch((err) => {
      const code = (err as { code?: string })?.code;
      if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
        const msg = formatErr(err);
        this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SESSION_ARCHIVE_FAILED, `reason=${msg}`);
      }
    });

    // 5. AsyncTaskSystem 业务动作（M#2 归属消费者 / Assembly 只构造不调）
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

    // 6. SummonTool 注册（候选 γ：结构性循环依赖妥协 / l6_assembly §7）
    // NOTE: SummonTool 闭包依赖 this.buildSystemPrompt / this.toolRegistry.formatForLLM
    //       Assembly 构造期 Runtime 尚未 new / 此 register 必须留在 Runtime 内
    const summonTool = new SummonTool(
      () => this.buildSystemPrompt(),
      () => this.toolRegistry.formatForLLM(this.toolRegistry.getAll()),
      (profile) => this.toolRegistry.formatForLLM(
        this.toolRegistry.getForProfile(profile as import('../../foundation/tool-protocol/index.js').ToolProfile),
      ),
      () => this.getCurrentMessages(),  // L4 turn state → factory injection
    );
    this.toolRegistry.register(summonTool);

    if (this.options.identityToolFilter) {
      this.options.identityToolFilter(this.toolRegistry);
    }

    this.initialized = true;
  }

  private async repairSessionIfNeeded(): Promise<void> {
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
    const auditAbsPath = this.systemFs.resolve('audit.tsv');
    const interruptionMessage = summarizeLastExit(this.systemFs, auditAbsPath);
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
    await this.llm.close();
  }

  /**
   * Format the injection text for an inbox message by its type.
   * user_chat: no prefix (user typed in the chat)
   * user_inbox_message: [user inbox message] prefix (user sent a message via CLI)
   * system events: [system message] prefix
   */
  protected async formatInboxMessage(type: string, from: string, body: string, timestamp?: string): Promise<string> {
    const ago = timestamp ? formatTimeAgo(timestamp) : '';
    const t = ago ? ` (${ago})` : '';

    switch (type) {
      case 'user_chat':
        return body;
      case 'user_inbox_message':
        return `[user inbox message${t}]\n${body}`;
      case 'crash_notification':
        return `[system message${t}] Claw "${from}" process exited abnormally.\n${body}`;
      case 'heartbeat': {
        const base = `[system message${t}] Heartbeat triggered. Please perform a routine check.`;
        try {
          const checklist = (await this.systemFs.read('HEARTBEAT.md')).trim();
          return checklist ? `${base}\n\n${checklist}` : base;
        } catch (e) {
          // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
          if (!isFileNotFound(e)) {
            const code = (e as NodeJS.ErrnoException)?.code;
            this.auditWriter.write(
              HEARTBEAT_AUDIT_EVENTS.CHECKLIST_READ_FAILED,
              `code=${code ?? 'unknown'}`,
              `error=${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return base;
        }
      }
      case 'message':
        return `[system message${t}] ${body}`;
      default:
        this.auditWriter.write(RUNTIME_AUDIT_EVENTS.INBOX_UNKNOWN_TYPE,
          `type=${type}`, `from=${from}`);
        return `[system message${t}] ${body}`;
    }
  }

  /**
   * Read and drain inbox/pending/*.md for this instance.
   * Uses drainAndDeliver() to move files to inflight/ (delivered but not yet acked).
   * Unaddressed messages are immediately acked; addressed handles returned for turn-end ack.
   * @protected available for reuse by subclass MotionRuntime
   */
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
    const { addressed } = this._splitAndAuditEntries(entries);
    const { injected, sources } = await this._formatInjected(addressed);

    // unaddressed messages are not part of this turn — ack immediately
    const addressedPaths = new Set(addressed.map(e => e.filePath));
    const unaddressedHandles = handles.filter(h => !addressedPaths.has(h.filePath));
    for (const h of unaddressedHandles) {
      try {
        await this.inboxReader.ack(h);
      } catch (e) {
        // best-effort ack; audit already emitted by InboxReader
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

  private async _drainEntriesOrEmpty(): Promise<{ entries: InboxEntry[]; handles: InboxHandle[] }> {
    try {
      return await this.inboxReader.drainAndDeliver();
    } catch (err) {
      if (err instanceof InboxListFailed || err instanceof InboxMoveFailed) {
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.INBOX_DRAIN_FAILED,
          `error=${err.constructor.name}`,
          `reason=${formatErr(err)}`,
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
    for (const { message, filePath } of addressed) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_INJECT,
        `file=${path.basename(filePath)}`,
        `type=${message.extraMeta?.__original_type ?? message.type}`,
        `from=${message.from}`,
        `to=${message.to || this.options.clawId}`,
        `pri=${message.priority}`,
      );
    }
    for (const { message, filePath } of unaddressed) {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.INBOX_UNADDRESSED,
        `file=${path.basename(filePath)}`,
        `type=${message.extraMeta?.__original_type ?? message.type}`,
        `from=${message.from}`,
        `to=${message.to}`,
      );
    }
    return { addressed, unaddressed };
  }

  private async _formatInjected(addressed: InboxEntry[]): Promise<{
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
  }> {
    const systemParts: string[] = [];
    const userChatParts: string[] = [];
    const sources: Array<{ text: string; type: string }> = [];
    for (const { message } of addressed) {
      const formatted = await this.formatInboxMessage(
        message.type,
        message.from,
        message.content,
        message.timestamp,
      );
      if (message.type === 'user_chat') {
        userChatParts.push(formatted);
      } else {
        systemParts.push(formatted);
      }
      sources.push({
        text: formatted.replace(/\r?\n/g, ' '),
        type: message.type,
      });
    }
    const allParts = [...systemParts, ...userChatParts];
    const injected: Message[] = allParts.length > 0
      ? [{ role: 'user', content: allParts.join('\n\n') }]
      : [];
    return { injected, sources };
  }

  /**
   * Run the LLM ReAct loop over the given messages and save the session.
   * @protected available for reuse by subclass MotionRuntime
   */
  protected async _runReact(messages: Message[], callbacks?: StreamCallbacks): Promise<void> {
    // phase 786: stopRequested 是 per-turn flag，每 turn 起首 reset
    // 防 P0.14 跨 turn sticky bug（done 工具误调后下 turn silent empty）
    this.execContext.stopRequested = false;
    this._currentMessages = messages;
    const tools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );
    const { systemPrompt, identityContent } = await this._resolveSystemPromptForRun();
    // phase 769: inject systemPrompt + tools for shadow sync path
    this._currentSystemPrompt = systemPrompt;
    this._currentTools = tools;

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

    // Wrap onToolResult to write audit event
    const origOnToolResult = callbacks?.onToolResult;
    const auditOnToolResult = (
      name: string, toolUseId: ToolUseId,
      result: ToolResult, step: number, maxSteps: number
    ) => {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.TOOL_RESULT, name, toolUseId,
        result.success ? 'ok' : 'err',
        `summary=${oneLine(result.content ?? '')}`,
      );
      origOnToolResult?.(name, toolUseId, result, step, maxSteps);
    };

    try {
      await runReact({
          messages: messages,
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
          onLLMResult: (info) => {
            if (info.error) {
              this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_ERROR, info.model, `error=${info.error}`, `latency_ms=${info.latencyMs}`);
            } else {
              this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_CALL, info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `latency_ms=${info.latencyMs}`);
            }
          },
          onStepComplete: async () => {
            await this.sessionManager.save({ systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId });
            // 步间检查：高优先级消息到达时提前结束本轮
            if (await this._hasHighPriorityInbox()) {
              this.currentAbortController?.abort({ type: 'step_yield' });
            }
          },
          onTextDelta: (d) => { emitProviderInfoOnce(); callbacks?.onTextDelta?.(d); },
          onTextEnd: callbacks?.onTextEnd,
          onThinkingDelta: (d) => { emitProviderInfoOnce(); callbacks?.onThinkingDelta?.(d); },
          onToolCall: (n, id) => { callbacks?.onToolCall?.(n, id); },
          onToolResult: auditOnToolResult,
          onBeforeLLMCall: () => { callbacks?.onBeforeLLMCall?.(); },
          onReset: (provider, timeoutMs) => {
            providerInfoEmitted = false;
            callbacks?.onProviderFailover?.({ from: provider, timeoutMs });
          },
          onProviderFailed: (provider, model, error) => {
            callbacks?.onProviderFailed?.({ provider, model, error });
          },
          onEmptyResponse: (stopReason) => {
            this.auditWriter.write(RUNTIME_AUDIT_EVENTS.LLM_EMPTY_RESPONSE, `stop_reason=${stopReason}`);
          },
          onUnknownStopReason: (stopReason) => {
            this.auditWriter.write(RUNTIME_AUDIT_EVENTS.LLM_UNKNOWN_STOP_REASON, `stop_reason=${stopReason}`);
          },
          onUnparseableToolUse: (stopReason) => {
            this.auditWriter.write(RUNTIME_AUDIT_EVENTS.LLM_UNPARSEABLE_TOOL_USE, `stop_reason=${stopReason}`);
          },
          onToolInputParseError: (toolName, toolUseId, rawInput) =>
            this.auditWriter.write(
              RUNTIME_AUDIT_EVENTS.TOOL_INPUT_PARSE_FAILED,
              toolName,
              toolUseId,
              `reason=parse_error`,
              `summary=${escapeForLog(rawInput)}`,
            ),
          onToolExecutionFailed: (toolName, toolUseId, errorType, errorMsg) =>
            this.auditWriter.write(
              RUNTIME_AUDIT_EVENTS.TOOL_EXECUTION_FAILED,
              toolName,
              toolUseId,
              `errorType=${errorType}`,
              `errorMsg=${escapeForLog(errorMsg)}`,
            ),
          onSafeCallbackError: (label, err) => {
            this.auditWriter.write(RUNTIME_AUDIT_EVENTS.STEP_EXECUTOR_CALLBACK_FAILED, label, `error=${formatErr(err)}`);
          },
          onMaxTokensPrebuiltOnlyFinal: (meta) => {
            this.auditWriter?.write(
              RUNTIME_AUDIT_EVENTS.MAX_TOKENS_PREBUILT_ONLY_FINAL,
              `prebuilt_count=${meta.prebuiltCount}`,
              `model=${meta.llm.model}`,
            );
          },
          onMaxTokensAssistantEmptySkipped: (meta) => {
            this.auditWriter?.write(
              RUNTIME_AUDIT_EVENTS.MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED,
              `model=${meta.llm.model}`,
            );
          },
          onMaxTokensStateAOrphanDrop: (args) => {
            for (const orphan of args.orphans) {
              this.auditWriter?.write(
                RUNTIME_AUDIT_EVENTS.MAX_TOKENS_STATE_A_ORPHAN_DROP,
                `tool_use_id=${orphan.tool_use_id}`,
                `is_error=${orphan.is_error}`,
                `content_preview=${escapeForLog(orphan.content_preview)}`,
                `model=${args.llm.model}`,
              );
            }
          },
        });
      await this.sessionManager.save({ systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId });

      // turn auto-commit
      this.turnCount++;
      const commitResult = await this.snapshot.commit(`turn-${this.turnCount} ${new Date().toISOString()}`).catch((err: unknown): null => {
        // 不可预期失败：audit 已在 snapshot 内写；此处仅暴露给诊断
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, err, `context=turn-${this.turnCount}`);
        return null;
      });
      if (commitResult && !commitResult.ok) {
        if (commitResult.error.kind === 'uncategorized') {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=turn-${this.turnCount}`, `exitCode=${commitResult.error.exitCode}`);
        } else {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, `context=turn-${this.turnCount}`, `kind=${commitResult.error.kind}`);
        }
      }

      // phase 521: turn 末 regime change 检测（per L5.G3 (a) 自动检测）
      await this._checkRegimeSwitch(systemPrompt, identityContent);
    } finally {
      this._currentMessages = undefined;
      this._currentSystemPrompt = undefined;
    }
  }

  /**
   * MVP alignment: batch-process inbox messages (polling-based batch instead of event-driven)
   * @returns number of injected messages (0 = nothing pending)
   */
  async processBatch(callbacks?: DaemonStreamCallbacks): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    const traceId = crypto.randomBytes(8).toString('hex');
    this.setTraceId(traceId);
    this.execContext.trace_id = traceId;
    try {
    const { injected, sources, count, infos, addressedHandles } = await this._drainOwnInbox();
    if (count === 0) return 0;

    // Notify daemon-loop of inbox messages for review_request handling
    if (callbacks?.onInboxMessages && infos.length > 0) {
      try {
        await callbacks.onInboxMessages(infos);
      } catch (e) {
        const reason = formatErr(e);
        this.auditWriter.write(RUNTIME_AUDIT_EVENTS.INBOX_HANDLER_FAILED, 'handler=onInboxMessages', `reason=${reason}`);
      }
    }

    const { session } = await this.sessionManager.load();
    const messages = [...session.messages, ...injected];
    const injectTools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );

    // Turn start
    callbacks?.onTurnStart?.(sources);
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    // AbortController support (same as chat() mode)
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;

    await this.sessionManager.beginTurn();
    try {
      // Save injected messages inside transaction
      await this.sessionManager.save({
        systemPrompt: session.systemPrompt,
        messages,
        toolsForLLM: injectTools,
        trace_id: traceId,
      });

      await this._runReact(messages, callbacks);

      // Turn completed normally
      callbacks?.onTurnEnd?.();
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);

      await this.sessionManager.commitTurn();
      for (const h of addressedHandles) {
        await this.inboxReader.ack(h);
      }
      return count;
    } catch (err) {
      // Turn-level error/interrupt event
      this._handleTurnInterrupt(err, callbacks);
      if (err instanceof PriorityInboxInterrupt
          || err instanceof UserInterrupt
          || err instanceof IdleTimeoutSignal) {
        // graceful interrupt：保留已完成 step 工作（dialog repair 在下次 load 处理悬空 tool_use）
        const reason = err instanceof PriorityInboxInterrupt ? 'priority_inbox'
                     : err instanceof UserInterrupt          ? 'user_interrupt'
                     :                                         'idle_timeout';
        await this.sessionManager.commitTurn(reason);
        for (const h of addressedHandles) {
          // PriorityInboxInterrupt + UserInterrupt: ack / IdleTimeoutSignal: nack 让下轮 redrive
          if (err instanceof PriorityInboxInterrupt || err instanceof UserInterrupt) {
            await this.inboxReader.ack(h);
          } else {
            await this.inboxReader.nack(h, formatErr(err));
          }
        }
      } else {
        await this.sessionManager.rollbackTurn(formatErr(err));
        for (const h of addressedHandles) {
          await this.inboxReader.nack(h, formatErr(err));
        }
      }
      // Notify each inbox sender so they're not left hanging
      if (err instanceof MaxStepsExceededError) {
        const errorMsg = err.message;
        for (const info of infos) {
          await this._writeErrorResponse(info, errorMsg, 'max_steps_exhausted');
        }
      } else if (!(err instanceof PriorityInboxInterrupt || err instanceof UserInterrupt || err instanceof IdleTimeoutSignal)) {
        // Non-interrupt error (LLM crash, tool error, etc.) — notify senders
        const errorMsg = formatErr(err);
        for (const info of infos) {
          await this._writeErrorResponse(info, errorMsg, 'non_interrupt_error');
        }
      }
      // Log unexpected errors to audit (aborts and MaxSteps are expected control flow)
      if (
        !(err instanceof PriorityInboxInterrupt || err instanceof UserInterrupt || err instanceof IdleTimeoutSignal) &&
        !(err instanceof MaxStepsExceededError)
      ) {
        const errorMsg = formatErr(err);
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.PROCESS_BATCH_FAILED,
          'context=Runtime.processBatch',
          `error=${errorMsg}`,
        );
      }
      throw err;
    } finally {
      this.currentAbortController = null;
      this.execContext.signal = undefined;
    }
    } finally {
      this.setTraceId(undefined);
      this.execContext.trace_id = undefined;
    }
  }

  /**
   * Process a single synthetic message directly (without draining inbox).
   * Used by daemon-loop for in-process startup trigger — message is never persisted to disk.
   */
  async processWithMessage(msg: Message, callbacks?: StreamCallbacks): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    const traceId = crypto.randomBytes(8).toString('hex');
    this.setTraceId(traceId);
    this.execContext.trace_id = traceId;
    try {
    const { session } = await this.sessionManager.load();
    const messages = [...session.messages, msg];
    const procTools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );
    await this.sessionManager.save({
      systemPrompt: session.systemPrompt,
      messages,
      toolsForLLM: procTools,
      trace_id: traceId,
    });
    callbacks?.onTurnStart?.([]);
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    try {
      await this._runReact(messages, callbacks);
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);
    } catch (err) {
      // Note: do NOT save messages here - see processBatch catch block for explanation
      this._handleTurnInterrupt(err, callbacks);
      throw err;
    } finally {
      this.currentAbortController = null;
      this.execContext.signal = undefined;
    }
    } finally {
      this.setTraceId(undefined);
      this.execContext.trace_id = undefined;
    }
  }

  /**
   * Retry the last turn without draining inbox.
   * Used by daemon-loop to recover from transient LLM errors.
   */
  async retryLastTurn(callbacks?: StreamCallbacks): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    const traceId = crypto.randomBytes(8).toString('hex');
    this.setTraceId(traceId);
    this.execContext.trace_id = traceId;
    try {
    const { session } = await this.sessionManager.load();
    if (session.messages.length === 0) return;

    // Find the last user message boundary for safe retry.
    // If messages end after assistant/tool_result steps, truncate back to the last
    // user message so we don't re-run from a partial state that could re-execute
    // non-idempotent tools.
    let retryMessages = session.messages;
    const lastUserIdx = [...session.messages].map(m => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) {
      // No user message at all — nothing to retry
      return;
    }
    if (lastUserIdx < session.messages.length - 1) {
      // Messages have assistant/tool content after the last user message.
      // Truncate so the retry starts from a clean user turn boundary.
      retryMessages = session.messages.slice(0, lastUserIdx + 1);
      const retryTools = this.toolRegistry.formatForLLM(
        this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
      );
      await this.sessionManager.save({
        systemPrompt: session.systemPrompt,
        messages: retryMessages,
        toolsForLLM: retryTools,
      });
    }

    // Retry is also a turn (tag it so stream consumers know it's a retry)
    callbacks?.onTurnStart?.([{ text: 'LLM retry', type: 'system_retry' }]);
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    try {
      await this._runReact(retryMessages, callbacks);
      callbacks?.onTurnEnd?.();
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);
    } catch (err) {
      this._handleTurnInterrupt(err, callbacks);
      throw err;
    } finally {
      this.currentAbortController = null;
      this.execContext.signal = undefined;
    }
    } finally {
      this.setTraceId(undefined);
      this.execContext.trace_id = undefined;
    }
  }

  /**
   * Interactive conversation (used by CLI)
   */
  async chat(
    userMessage: string,
    options?: {
      onToolCall?: (toolName: string, toolUseId: ToolUseId) => void;
      onBeforeLLMCall?: () => void;
      onToolResult?: (toolName: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
      onTextDelta?: (delta: string) => void;  // streaming text delta
      onThinkingDelta?: (delta: string) => void;  // streaming thinking delta
      onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
    }
  ): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    const traceId = crypto.randomBytes(8).toString('hex');
    this.setTraceId(traceId);
    this.execContext.trace_id = traceId;
    try {
    // 1. Load the current session
    const { session } = await this.sessionManager.load();
    const messages = [...session.messages];

    // 2. Build systemPrompt (already includes AGENTS.md + MEMORY.md + skills + contract)
    const { systemPrompt, identityContent } = await this._resolveSystemPromptForRun();

    // 3. Append the user message
    messages.push({ role: 'user', content: userMessage });

    // 4. Get tool definitions
    const tools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );

    // 5. Run the ReAct loop (with incremental session saves)
    // align _processBatch turn-start reset, per phase 786 + phase 900 cluster sweep
    this.execContext.stopRequested = false;
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    let chatProviderInfoEmitted = false;
    const emitChatProviderInfoOnce = () => {
      if (!chatProviderInfoEmitted) {
        const info = this.llm.getProviderInfo();
        if (info) {
          chatProviderInfoEmitted = true;
          options?.onProviderInfo?.(info);
        }
      }
    };

    try {
      const result = await runReact({
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
        onLLMResult: (info) => {
          if (info.error) {
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_ERROR, info.model, `error=${info.error}`, `latency_ms=${info.latencyMs}`);
          } else {
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_CALL, info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `latency_ms=${info.latencyMs}`);
          }
        },
        onToolCall: options?.onToolCall,
        onBeforeLLMCall: options?.onBeforeLLMCall,
        onToolResult: options?.onToolResult,
        onTextDelta: (d) => { emitChatProviderInfoOnce(); options?.onTextDelta?.(d); },
        onThinkingDelta: (d) => { emitChatProviderInfoOnce(); options?.onThinkingDelta?.(d); },
        onStepComplete: async () => {
          // Incremental session save
          await this.sessionManager.save({ systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId });
        },
        onUnparseableToolUse: (stopReason) => {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.LLM_UNPARSEABLE_TOOL_USE, `stop_reason=${stopReason}`);
        },
        onSafeCallbackError: (label, err) => {
          this.auditWriter.write(RUNTIME_AUDIT_EVENTS.STEP_EXECUTOR_CALLBACK_FAILED, label, `error=${formatErr(err)}`);
        },
        onMaxTokensPrebuiltOnlyFinal: (meta) => {
          this.auditWriter?.write(
            RUNTIME_AUDIT_EVENTS.MAX_TOKENS_PREBUILT_ONLY_FINAL,
            `prebuilt_count=${meta.prebuiltCount}`,
            `model=${meta.llm.model}`,
          );
        },
        onMaxTokensAssistantEmptySkipped: (meta) => {
          this.auditWriter?.write(
            RUNTIME_AUDIT_EVENTS.MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED,
            `model=${meta.llm.model}`,
          );
        },
        onMaxTokensStateAOrphanDrop: (args) => {
          for (const orphan of args.orphans) {
            this.auditWriter?.write(
              RUNTIME_AUDIT_EVENTS.MAX_TOKENS_STATE_A_ORPHAN_DROP,
              `tool_use_id=${orphan.tool_use_id}`,
              `is_error=${orphan.is_error}`,
              `content_preview=${escapeForLog(orphan.content_preview)}`,
              `model=${args.llm.model}`,
            );
          }
        },
      });

      // Save the final session
      await this.sessionManager.save({ systemPrompt, messages, toolsForLLM: tools, trace_id: this.currentTraceId });

      // phase 521: turn 末 regime change 检测（chat() 也走 _runReact 等效路径）
      await this._checkRegimeSwitch(systemPrompt, identityContent);

      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);

      // Return the final text
      return result.finalText;
    } catch (err) {
      this._handleTurnInterrupt(err);
      throw err;
    } finally {
      this.currentAbortController = null;
      this.execContext.signal = undefined;
    }
    } finally {
      this.setTraceId(undefined);
      this.execContext.trace_id = undefined;
    }
  }

  /**
   * Abort the currently running chat() call
   */
  abort(): void {
    this.currentAbortController?.abort({ type: 'user' });
  }

  /**
   * Handle turn interrupt/error and audit
   */
  private _handleTurnInterrupt(err: unknown, callbacks?: StreamCallbacks): void {
    if (err instanceof IdleTimeoutSignal) {
      const msg = `Interrupted (idle timeout: ${Math.round(err.timeoutMs / 1000)}s)`;
      callbacks?.onTurnInterrupted?.('idle_timeout', msg);
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${err.timeoutMs}`);
    } else if (err instanceof PriorityInboxInterrupt) {
      callbacks?.onTurnInterrupted?.('priority_inbox', 'Interrupted (priority inbox)');
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
    } else if (err instanceof UserInterrupt) {
      callbacks?.onTurnInterrupted?.('user_interrupt');  // 不传 message，让 viewport 自行决定显示
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
    } else {
      const errorMsg = formatErr(err);
      callbacks?.onTurnError?.(errorMsg);
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${errorMsg}`);
    }
  }

  /**
   * Write an error response to a sender's outbox, with audit + console fallback.
   *
   * Design intent (per phase 622 ratify ⚓2 = α / l5_runtime §B.outbox-error-response-strategy):
   * outbox 失败 silent + audit OUTBOX_WRITE_FAILED / best-effort error reply
   * caller 不阻塞（不 throw）/ context=error_response + scenario + reason 子场景区分
   * 既有 audit_injection_alpha 模板 align / 0 NEW const（β reframe per zero_new_interface_field_reuse N=7）
   */
  private async _writeErrorResponse(
    info: InboxMessage,
    errorMsg: string,
    scenario: 'max_steps_exhausted' | 'non_interrupt_error',
  ): Promise<void> {
    const sender = info.from;
    if (!sender) return;

    await this.outboxWriter.write({
      type: 'response',
      to: sender,
      content: `Error: ${errorMsg}`,
      metadata: info.metadata?.contract_id ? { contract_id: info.metadata.contract_id } : undefined,
    }).catch(e => {
      const reason = formatErr(e);
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.OUTBOX_WRITE_FAILED,
        'context=error_response',
        `scenario=${scenario}`,
        `reason=${reason}`,
      );
    });
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
    clawId: ClawId;
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

  private async ensureDirectories(_clawDir: ClawDir): Promise<void> {
    for (const dir of CLAW_SUBDIRS) {
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
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED, err);
        // lastIdentityHash 不更新 → 下 turn 重试自愈（D7）
      }
    } else {
      this.lastIdentityHash = identityContent;
    }
  }

  private async _performRegimeSwitch(newSystemPrompt: string): Promise<void> {
    const strategy = this.options.regimeSwitchStrategy ?? 'all';
    // 1. 加载 oldMessages
    const { session } = await this.sessionManager.load();
    const oldMessages = session.messages;
    // 2. archive 当前 sessionManager
    try {
      await this.sessionManager.archive();
    } catch (e) {
      const msg = formatErr(e);
      this.auditWriter.write(RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_HARD_FAIL, `reason=${msg}`);
      throw e;  // NEW phase 1373 sub-2: fail-fast / 不 silent continue
    }
    // 3. 计算 inherited per strategy
    let inherited: Message[];
    switch (strategy) {
      case 'none': inherited = []; break;
      case 'last-turn': inherited = extractLastTurn(oldMessages); break;
      case 'all':
        inherited = oldMessages;
        break;
      default:
        this.auditWriter.write(RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED,
          'context=unknown_strategy', `strategy=${strategy}`);
        inherited = oldMessages;
    }
    // 4. tool_use 悬空 repair（per L5.G4）
    const { repaired } = DialogStore.repair(inherited, { interruptionMessage: 'Regime switch: tools may have changed.' });
    // 5. prepare newSessionManager（0 fs mutate / verified store.ts:29-41）
    const newSessionManager = this.dialogStoreFactory();
    // 6. save inherited 到 newSessionManager (atomic critical)
    const regimeTools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );
    try {
      await newSessionManager.save({
        systemPrompt: newSystemPrompt,
        messages: repaired,
        toolsForLLM: regimeTools,
      });
    } catch (saveErr) {
      // catch recovery dump (D1+D5 兜底 / 类 phase 586 audit fallback dump 模板)
      const recoveryPath = path.join(this.options.clawDir, DIALOG_DIR, `regime-switch-recovery-${Date.now()}.json`);
      try {
        const recoveryData = JSON.stringify({
          systemPrompt: newSystemPrompt,
          repaired,
          original: oldMessages,
          strategy,
          timestamp: new Date().toISOString(),
          reason: saveErr instanceof Error ? saveErr.message : String(saveErr),
        }, null, 2);
        await this.systemFs.writeAtomic(recoveryPath, recoveryData);
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED,
          `phase=save`,
          `recovery_path=${recoveryPath}`,
          `inherited_count=${repaired.length}`,
          `reason=${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        );
      } catch (dumpErr) {
        // dump 失败的 final fallback：纯 audit / inherited 极端场景丢失
        this.auditWriter.write(
          RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED,
          `phase=save_and_dump`,
          `recovery_path=${recoveryPath}`,
          `save_reason=${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
          `dump_reason=${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)}`,
          `inherited_count=${repaired.length}`,
        );
      }
      throw saveErr;   // 让 outer _checkRegimeSwitch catch 处理 lastIdentityHash 不更新
    }
    // 7. commit 替换（仅 save 成功后）
    this.sessionManager = newSessionManager;
    // 8. audit 成功
    this.auditWriter.write(
      RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_COMMITTED,
      `strategy=${strategy}`,
      `inherited=${repaired.length}`,
    );
    this.auditWriter.write(
      RUNTIME_AUDIT_EVENTS.REGIME_SWITCH,
      `strategy=${strategy}`,
      `inherited=${repaired.length}`,
      `discarded=${oldMessages.length - repaired.length}`,
    );
  }

}

