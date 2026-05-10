/**
 * Runtime - assembles all modules into a runnable Claw instance
 *
 * Final assembly layer integrating L1-L4 modules into runnable Claw instance.
 * 详 design/architecture.md + design/modules/l5_runtime.md。
 */

import * as path from 'path';

import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ToolProfile } from '../../types/config.js';
import type { Message } from '../../types/message.js';
import type { InboxMessage } from '../../types/messaging.js';
import type { Priority } from '../../types/priority.js';
import type { OutboxWriteOptions } from '../../foundation/messaging/index.js';
import type { SessionData } from '../../foundation/dialog-store/index.js';
import { InboxListFailed, InboxMoveFailed } from '../../foundation/messaging/index.js';

import { DialogStore } from '../../foundation/dialog-store/index.js';
import { DispatchTool } from '../async-task-system/tools/dispatch.js';
import { runReact } from '../agent-executor/loop.js';
import { summarizeLastExit } from './last-exit-summary.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../types/signals.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import { RUNTIME_AUDIT_EVENTS, REACT_LOOP_AUDIT_EVENTS } from './runtime-audit-events.js';
import { CLAW_SUBDIRS, DIALOG_DIR } from '../../types/paths.js';
import { oneLine } from '../../types/utils.js';
import { MaxStepsExceededError } from '../../types/errors.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_STEPS, DEFAULT_MAX_CONCURRENT_TASKS } from '../../constants.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Snapshot } from '../../foundation/snapshot/index.js';
import type { InboxReader, InboxEntry } from '../../foundation/messaging/inbox-reader.js';
import type { OutboxWriter } from '../../foundation/messaging/outbox-writer.js';
import type { ExecContext } from '../../foundation/tool-protocol/index.js';
import type { ToolRegistry, IToolExecutor } from '../../foundation/tools/executor.js';
import type { ContextInjector } from '../dialog/injector.js';
import type { ContractSystem } from '../contract/index.js';
import type { SkillSystem } from '../../foundation/skill-system/index.js';
import type { AsyncTaskSystem } from '../async-task-system/index.js';
import {
  type RuntimeDependencies,
  type RuntimeOptions,
  type StreamCallbacks,
  type DaemonStreamCallbacks,
} from './types.js';
import { formatTimeAgo } from './utils.js';

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

  // Foundation
  /**
   * @protected allows subclasses such as MotionRuntime to read system files (SOUL.md, etc.)
   * Note: subclasses should not write directly; preserve runtime encapsulation
   */
  protected systemFs!: FileSystem;  // used by system components (no permission check)
  private clawFs!: FileSystem;    // used by tools (with permission check)
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
  private skillRegistry!: SkillSystem;
  private contractManager!: ContractSystem;
  protected execContext!: ExecContext;
  protected toolExecutor!: IToolExecutor;
  private inboxReader!: InboxReader;
  private outboxWriter!: OutboxWriter;
  private snapshot!: Snapshot;

  // phase 521: regime switch coordination
  private dialogStoreFactory!: (systemPrompt: string) => DialogStore;
  private lastIdentityHash?: string;

  constructor(options: RuntimeOptions) {
    this.options = {
      maxSteps: DEFAULT_MAX_STEPS,
      toolProfile: 'full',
      toolTimeoutMs: 60000,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
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

  /**
   * Initialize all modules
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { clawDir } = this.options;
    const deps = this.options.dependencies;

    // 1. 目录结构（业务初始化，Assembly 不管）
    await this.ensureDirectories(clawDir);

    // 2. 消费 deps（16 字段赋值）
    this.systemFs = deps.systemFs;
    this.clawFs = deps.clawFs;
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
    this.skillRegistry = deps.skillRegistry;
    this.contractManager = deps.contractManager;
    this.taskSystem = deps.taskSystem;
    this.contextInjector = deps.contextInjector;
    this.execContext = deps.execContext;

    // 3. 归档上一次 session（first-run ENOENT 允许）
    await this.sessionManager.archive().catch((err) => {
      const code = (err as { code?: string })?.code;
      if (code !== 'ENOENT' && code !== 'FS_NOT_FOUND') {
        const msg = formatErr(err);
        this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SESSION_ARCHIVE_FAILED, `reason=${msg}`);
      }
    });

    // 4. Session repair（业务链路）
    await this.repairSessionIfNeeded();

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

    // 6. DispatchTool 注册（候选 γ：结构性循环依赖妥协 / l6_assembly §7）
    // NOTE: DispatchTool 闭包依赖 this.buildSystemPrompt / this.toolRegistry.formatForLLM
    //       Assembly 构造期 Runtime 尚未 new / 此 register 必须留在 Runtime 内
    const dispatchTool = new DispatchTool(
      () => this.buildSystemPrompt(),
      () => this.toolRegistry.formatForLLM(this.toolRegistry.getAll()),
      (profile) => this.toolRegistry.formatForLLM(
        this.toolRegistry.getForProfile(profile as import('../../types/config.js').ToolProfile),
      ),
    );
    this.toolRegistry.register(dispatchTool);

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
        await this.sessionManager.save(repaired);
      } catch (e) {
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SESSION_REPAIR_FAILED, e);
        throw e;
      }
      this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SESSION_REPAIRED, `tools=${toolCount}`);
      const result = await this.snapshot.commit(`session-repair tools=${toolCount}`).catch((err: unknown): null => {
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, err, `context=session-repair`);
        return null;
      });
      if (result && !result.ok && result.error.kind === 'uncategorized') {
        this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=session-repair`, `exitCode=${result.error.exitCode}`);
      }
    }
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    await this.taskSystem.shutdown(30_000);
    await this.llm.close();
  }

  /**
   * MVP alignment: resume a paused contract (extracted from start())
   */
  async resumeContractIfPaused(): Promise<void> {
    const paused = await this.contractManager.loadPaused();
    if (paused) {
      await this.contractManager.resume(paused.id);
    }
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
        } catch {
          return base;
        }
      }
      case 'message':
      default:
        return `[system message${t}] ${body}`;
    }
  }

  /**
   * Read and drain inbox/pending/*.md for this instance.
   * Files are moved to the done directory immediately after reading (messages are already in memory).
   * @protected available for reuse by subclass MotionRuntime
   */
  protected async _drainOwnInbox(): Promise<{
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    count: number;
    infos: InboxMessage[];
  }> {
    const entries = await this._drainEntriesOrEmpty();
    if (entries.length === 0) {
      return { injected: [], sources: [], count: 0, infos: [] };
    }
    const { addressed, unaddressed } = this._splitAndAuditEntries(entries);
    const truncated = await this._markDoneAndTruncate(addressed, unaddressed);
    const { injected, sources } = await this._formatInjected(truncated);
    return {
      injected,
      sources,
      count: truncated.length,
      infos: truncated.map(e => e.message),
    };
  }

  private async _drainEntriesOrEmpty(): Promise<InboxEntry[]> {
    try {
      return await this.inboxReader.drainInbox();
    } catch (err) {
      if (err instanceof InboxListFailed || err instanceof InboxMoveFailed) {
        // audit 已在 drainInbox 内写；此处只需保守退出本轮
        return [];
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

  private async _markDoneAndTruncate(
    addressed: InboxEntry[],
    unaddressed: InboxEntry[],
  ): Promise<InboxEntry[]> {
    const allEntries = [...addressed, ...unaddressed];
    let processedCount = 0;
    for (const { filePath } of allEntries) {
      try {
        await this.inboxReader.markDone(filePath);
        processedCount++;
      } catch (err) {
        if (err instanceof InboxMoveFailed) {
          // markDone 失败：该消息 + 之后未处理消息留 pending / 下次 drainInbox 重拉
          // audit 已在 markDone 内写 / 截断 returned addressed 防重复 inject
          break;
        }
        throw err;
      }
    }
    // 截断 addressed 到 successfully markDone 数（防重复 inject）
    return addressed.slice(0, Math.min(processedCount, addressed.length));
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
    this.execContext.dialogMessages = messages;
    const tools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );
    const { systemPrompt, identityHash } = await this._resolveSystemPromptForRun();

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
      name: string, toolUseId: string,
      result: ToolResult, step: number, maxSteps: number
    ) => {
      this.auditWriter.write(
        RUNTIME_AUDIT_EVENTS.TOOL_RESULT, name, toolUseId,
        result.success ? 'ok' : 'err',
        `summary=${oneLine(result.content ?? '')}`,
      );
      origOnToolResult?.(name, toolUseId, result, step, maxSteps);
    };

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
        idleTimeoutMs: this.options.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS,
        onLLMResult: (info) => {
          if (info.error) {
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_ERROR, info.model, `err=${info.error}`, `ms=${info.latencyMs}`);
          } else {
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_CALL, info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `ms=${info.latencyMs}`);
          }
        },
        onStepComplete: async () => {
          await this.sessionManager.save(messages);
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
      });
    await this.sessionManager.save(messages);

    // turn auto-commit
    this.turnCount++;
    const commitResult = await this.snapshot.commit(`turn-${this.turnCount} ${new Date().toISOString()}`).catch((err: unknown): null => {
      // 不可预期失败：audit 已在 snapshot 内写；此处仅暴露给诊断
      auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, err, `context=turn-${this.turnCount}`);
      return null;
    });
    if (commitResult && !commitResult.ok && commitResult.error.kind === 'uncategorized') {
      this.auditWriter.write(RUNTIME_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=turn-${this.turnCount}`, `exitCode=${commitResult.error.exitCode}`);
    }

    // phase 521: turn 末 regime change 检测（per L5.G3 (a) 自动检测）
    await this._checkRegimeSwitch(systemPrompt, identityHash);
  }

  /**
   * MVP alignment: batch-process inbox messages (polling-based batch instead of event-driven)
   * @returns number of injected messages (0 = nothing pending)
   */
  async processBatch(callbacks?: DaemonStreamCallbacks): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { injected, sources, count, infos } = await this._drainOwnInbox();
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

    // Save injected messages immediately so interrupt doesn't lose them
    await this.sessionManager.save(messages);

    // Turn start: inbox drained and persisted, processing about to begin
    callbacks?.onTurnStart?.(sources);
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    // AbortController support (same as chat() mode)
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    try {
      await this._runReact(messages, callbacks);

      // Turn completed normally
      callbacks?.onTurnEnd?.();
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);

      return count;
    } catch (err) {
      // Turn-level error/interrupt event
      this._handleTurnInterrupt(err, callbacks);
      // Note: do NOT save messages here - _runReact modifies messages in-place
      // and may leave them in an invalid state (e.g., tool_use without tool_result).
      // Valid states are already covered by:
      // 1. The save at line 486 (before _runReact) - preserves injected messages
      // 2. onStepComplete callback - saves after each complete step
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
  }

  /**
   * Process a single synthetic message directly (without draining inbox).
   * Used by daemon-loop for in-process startup trigger — message is never persisted to disk.
   */
  async processWithMessage(msg: Message, callbacks?: StreamCallbacks): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    const { session } = await this.sessionManager.load();
    const messages = [...session.messages, msg];
    await this.sessionManager.save(messages);
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
  }

  /**
   * Retry the last turn without draining inbox.
   * Used by daemon-loop to recover from transient LLM errors.
   */
  async retryLastTurn(callbacks?: StreamCallbacks): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
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
      await this.sessionManager.save(retryMessages);
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
  }

  /**
   * Interactive conversation (used by CLI)
   */
  async chat(
    userMessage: string,
    options?: {
      onToolCall?: (toolName: string, toolUseId: string) => void;
      onBeforeLLMCall?: () => void;
      onToolResult?: (toolName: string, toolUseId: string, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
      onTextDelta?: (delta: string) => void;  // streaming text delta
      onThinkingDelta?: (delta: string) => void;  // streaming thinking delta
      onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
    }
  ): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    // 1. Load the current session
    const { session } = await this.sessionManager.load();
    const messages = [...session.messages];

    // 2. Build systemPrompt (already includes AGENTS.md + MEMORY.md + skills + contract)
    const { systemPrompt, identityHash } = await this._resolveSystemPromptForRun();

    // 3. Append the user message
    messages.push({ role: 'user', content: userMessage });

    // 4. Get tool definitions
    const tools = this.toolRegistry.formatForLLM(
      this.toolRegistry.getForProfile(this.options.toolProfile ?? 'full')
    );

    // 5. Run the ReAct loop (with incremental session saves)
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
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_ERROR, info.model, `err=${info.error}`, `ms=${info.latencyMs}`);
          } else {
            this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_CALL, info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `ms=${info.latencyMs}`);
          }
        },
        onToolCall: options?.onToolCall,
        onBeforeLLMCall: options?.onBeforeLLMCall,
        onToolResult: options?.onToolResult,
        onTextDelta: (d) => { emitChatProviderInfoOnce(); options?.onTextDelta?.(d); },
        onThinkingDelta: (d) => { emitChatProviderInfoOnce(); options?.onThinkingDelta?.(d); },
        onStepComplete: async () => {
          // Incremental session save
          await this.sessionManager.save(messages);
        },
      });

      // Save the final session
      await this.sessionManager.save(messages);

      // phase 521: turn 末 regime change 检测（chat() 也走 _runReact 等效路径）
      await this._checkRegimeSwitch(systemPrompt, identityHash);

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
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `ms=${err.timeoutMs}`);
    } else if (err instanceof PriorityInboxInterrupt) {
      callbacks?.onTurnInterrupted?.('priority_inbox', 'Interrupted (priority inbox)');
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
    } else if (err instanceof UserInterrupt) {
      callbacks?.onTurnInterrupted?.('user_interrupt');  // 不传 message，让 viewport 自行决定显示
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
    } else {
      const errorMsg = formatErr(err);
      callbacks?.onTurnError?.(errorMsg);
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `err=${errorMsg}`);
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
      contract_id: info.contract_id,
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
    clawId: string;
  } {
    return {
      initialized: this.initialized,
      clawId: this.options.clawId,
    };
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
   * Resolve systemPrompt + identityHash for a turn run.
   * - If systemPromptBuilder is configured, use full prompt as identityHash (U3 (a) / phase 521 兼容).
   * - Else, use contextInjector.buildSystemPromptForRegime() to get full + identityHash 分层。
   */
  private async _resolveSystemPromptForRun(): Promise<{
    systemPrompt: string;
    identityHash: string;
  }> {
    if (this.options.systemPromptBuilder) {
      const systemPrompt = await this.buildSystemPrompt();
      return { systemPrompt, identityHash: systemPrompt };
    }
    const r = await this.contextInjector.buildSystemPromptForRegime();
    return { systemPrompt: r.full, identityHash: r.identityHash };
  }

  private async ensureDirectories(clawDir: string): Promise<void> {
    // Use the shared constant (consistent with createCommand)
    // Use Node fs directly to create directories (NodeFileSystem is not yet initialized)
    const { promises: nodeFs } = await import('fs');
    for (const dir of CLAW_SUBDIRS) {
      await nodeFs.mkdir(path.join(clawDir, dir), { recursive: true });
    }
  }

  getAuditWriter(): AuditLog {
    return this.auditWriter;
  }

  // ============================================================================
  // phase 521: regime switch coordination
  // ============================================================================

  private async _checkRegimeSwitch(newSystemPrompt: string, identityHash: string): Promise<void> {
    if (this.lastIdentityHash !== undefined && this.lastIdentityHash !== identityHash) {
      try {
        await this._performRegimeSwitch(newSystemPrompt);
        this.lastIdentityHash = identityHash;
      } catch (err) {
        auditError(this.auditWriter, RUNTIME_AUDIT_EVENTS.REGIME_SWITCH_FAILED, err);
        // lastIdentityHash 不更新 → 下 turn 重试自愈（D7）
      }
    } else {
      this.lastIdentityHash = identityHash;
    }
  }

  private async _performRegimeSwitch(newSystemPrompt: string): Promise<void> {
    const strategy = this.options.regimeSwitchStrategy ?? 'all';
    // 1. 加载 oldMessages
    const { session } = await this.sessionManager.load();
    const oldMessages = session.messages;
    // 2. archive 当前 sessionManager
    await this.sessionManager.archive();
    // 3. 计算 inherited per strategy
    let inherited: Message[];
    switch (strategy) {
      case 'none': inherited = []; break;
      case 'last-turn': inherited = extractLastTurn(oldMessages); break;
      case 'all':
      default: inherited = oldMessages;
    }
    // 4. tool_use 悬空 repair（per L5.G4）
    const { repaired } = DialogStore.repair(inherited, { interruptionMessage: 'Regime switch: tools may have changed.' });
    // 5. prepare newSessionManager（0 fs mutate / verified store.ts:29-41）
    const newSessionManager = this.dialogStoreFactory(newSystemPrompt);
    // 6. save inherited 到 newSessionManager (atomic critical)
    try {
      await newSessionManager.save(repaired);
    } catch (saveErr) {
      // catch recovery dump (D1+D5 兜底 / 类 phase 586 audit fallback dump 模板)
      try {
        const recoveryPath = path.join(this.options.clawDir, DIALOG_DIR, `regime-switch-recovery-${Date.now()}.json`);
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
      RUNTIME_AUDIT_EVENTS.REGIME_SWITCH,
      `strategy=${strategy}`,
      `inherited=${repaired.length}`,
      `discarded=${oldMessages.length - repaired.length}`,
    );
  }

}

