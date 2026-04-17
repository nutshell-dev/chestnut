/**
 * ClawRuntime - assembles all modules into a runnable Claw instance
 *
 * This is the final assembly layer for Phase 1, integrating the following modules into a unified runtime:
 * - Foundation: NodeFileSystem, LLMService, JsonlLogger
 * - Core: Dialog, Tools, ReAct, Communication, Task, Skill, Contract
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import type { LLMServiceConfig } from '../foundation/llm/types.js';
import type { ToolProfile } from '../types/config.js';
import type { Message } from '../types/message.js';
import type { InboxMessage, Priority } from '../types/contract.js';
import type { OutboxWriteOptions } from './communication/index.js';
import type { SessionData } from '../foundation/session-store/index.js';
import { readInboxFileMeta } from '../foundation/messaging/index.js';

import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import { LLMService } from '../foundation/llm/service.js';
import { JsonlLogger } from '../foundation/monitor/monitor.js';


import { SessionManager } from '../foundation/session-store/index.js';
import { ContextInjector } from './dialog/injector.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolExecutorImpl } from './tools/executor.js';
import { ExecContextImpl } from './tools/context.js';
import { registerBuiltinTools } from './tools/builtins/index.js';
import { DispatchTool } from './tools/builtins/dispatch.js';
import { readTool } from './tools/builtins/read.js';
import { lsTool } from './tools/builtins/ls.js';
import { searchTool } from './tools/builtins/search.js';
import { execTool } from './tools/builtins/exec.js';
import { runReact } from './react/loop.js';
import { summarizeLastExit } from './last-exit-summary.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../types/signals.js';
import type { ToolResult } from './tools/executor.js';
import { AuditWriter } from '../foundation/audit/writer.js';
import { InboxReader } from '../foundation/messaging/index.js';
import { OutboxWriter } from './communication/index.js';
import { TaskSystem } from './task/system.js';
import { SkillRegistry } from './skill/registry.js';
import { ContractManager } from './contract/manager.js';
import { CLAW_SUBDIRS } from '../types/paths.js';
import { oneLine } from '../foundation/utils/string.js';
import { Snapshot } from '../foundation/snapshot/index.js';
import { MaxStepsExceededError } from '../types/errors.js';
import { MOTION_CLAW_ID, DEFAULT_LLM_IDLE_TIMEOUT_MS, DEFAULT_MAX_STEPS, DEFAULT_MAX_CONCURRENT_TASKS } from '../constants.js';

/**
 * ClawRuntime constructor options
 */
export interface ClawRuntimeOptions {
  clawId: string;
  clawDir: string;
  llmConfig: LLMServiceConfig;
  monitorDir?: string;
  maxSteps?: number;
  toolProfile?: ToolProfile;
  toolTimeoutMs?: number;
  subagentMaxSteps?: number;
  maxConcurrentTasks?: number;
  idleTimeoutMs?: number;  // 覆盖 DEFAULT_LLM_IDLE_TIMEOUT_MS（0 = 禁用）
  auditMaxSizeMb?: number | null;   // 审计日志大小限制（MB），null = 不限
  auditWriter?: AuditWriter;
}

/**
 * ReAct 循环的流式事件回调
 * daemon 专用的 onInboxMessages 在下方 DaemonStreamCallbacks 扩展定义
 */
export interface StreamCallbacks {
  onBeforeLLMCall?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: string) => void;
  onToolResult?: (toolName: string, toolUseId: string, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
  onTurnStart?: (sources: Array<{ text: string; type: string }>) => void;
  onTurnEnd?: () => void;
  onTurnError?: (error: string) => void;
  onTurnInterrupted?: (cause: string, message?: string) => void;
  onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
  /** Provider timed out mid-stream, failover starting */
  onProviderFailover?: (info: { from: string; timeoutMs: number }) => void;
  /** Provider failed, failover continuing to next provider */
  onProviderFailed?: (info: { provider: string; model: string; error: string }) => void;
}

/** daemon 专用回调，在 StreamCallbacks 基础上增加 inbox 通知 */
export interface DaemonStreamCallbacks extends StreamCallbacks {
  onInboxMessages?: (messages: InboxMessage[]) => Promise<void>;
}

/**
 * ClawRuntime - fully assembled Claw runtime instance
 */
export class ClawRuntime {
  protected options: ClawRuntimeOptions;
  protected initialized = false;
  private currentAbortController: AbortController | null = null;
  private turnCount = 0;
  protected auditWriter!: AuditWriter;

  // Foundation
  /**
   * @protected allows subclasses such as MotionRuntime to read system files (SOUL.md, etc.)
   * Note: subclasses should not write directly; preserve runtime encapsulation
   */
  protected systemFs!: NodeFileSystem;  // used by system components (no permission check)
  private clawFs!: NodeFileSystem;    // used by tools (with permission check)
  private monitor!: JsonlLogger;
  protected llm!: LLMService;


  // Core
  protected sessionManager!: SessionManager;
  /**
   * @protected allows subclasses such as MotionRuntime to call buildParts() to customize prompt injection order
   * Note: subclasses should treat this as read-only and must not modify injector state
   */
  protected contextInjector!: ContextInjector;
  protected toolRegistry!: ToolRegistry;
  private taskSystem!: TaskSystem;
  private skillRegistry!: SkillRegistry;
  private contractManager!: ContractManager;
  protected execContext!: ExecContextImpl;
  protected toolExecutor!: ToolExecutorImpl;
  private inboxReader!: InboxReader;
  private outboxWriter!: OutboxWriter;
  private snapshot!: Snapshot;

  constructor(options: ClawRuntimeOptions) {
    this.options = {
      maxSteps: DEFAULT_MAX_STEPS,
      toolProfile: 'full',
      toolTimeoutMs: 60000,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
      ...options,
    };
    if (options.auditWriter) {
      this.auditWriter = options.auditWriter;
    }
  }

  /**
   * Initialize all modules
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { clawId, clawDir, llmConfig, monitorDir, maxSteps, toolProfile } = this.options;

    // 1. Create directory structure
    await this.ensureDirectories(clawDir);

    // 2. Create two NodeFileSystem instances
    // systemFs: used by system components (dialog/, contract/, etc.), no permission enforcement
    if (this.auditWriter) {
      // 外部已注入 auditWriter，复用其 fs 作为 systemFs
      this.systemFs = this.auditWriter.getFs() as NodeFileSystem;
    } else {
      this.systemFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
      // 2.1 创建 AuditWriter（后续所有 audit 事件共用此实例）
      this.auditWriter = new AuditWriter(
        this.systemFs,
        'audit.tsv',
        this.options.auditMaxSizeMb ?? null,
      );
    }
    // clawFs: used by tools, enforces permission checks
    this.clawFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: true });

    // 2.5 Clean up orphaned temp files at startup (best-effort)
    this.systemFs.cleanupTempFiles().catch(err => {
      console.warn('[runtime] Failed to cleanup temp files:', err);
    });

    // 3. Create JsonlLogger
    const logsDir = monitorDir || path.join(clawDir, 'logs');
    this.monitor = new JsonlLogger({ logsDir });

    // 4. Create LLMService
    this.llm = new LLMService(llmConfig);

    // 5. Compute workspaceDir for ContractManager motion inbox path
    const workspaceDir = clawId === MOTION_CLAW_ID
      ? path.resolve(clawDir, '..')
      : path.resolve(clawDir, '..', '..');

    // 6. Create SessionManager (uses systemFs; system components need to write to dialog/)
    this.sessionManager = new SessionManager(this.systemFs, 'dialog', clawId, this.auditWriter);
    // Archive previous session on startup (best-effort; first start has no current.json)
    await this.sessionManager.archive().catch((err: any) => {
      if (err?.code !== 'ENOENT' && err?.code !== 'FS_NOT_FOUND') {
        console.warn('[runtime] Failed to archive session on startup:', err?.message);
      }
    });

    // 2.x 初始化 Snapshot
    this.snapshot = new Snapshot(this.options.clawDir, this.auditWriter);

    // Session repair：检测未完成的 tool_use，注入合成 tool_result
    {
      const loadResult = await this.sessionManager.load().catch(() => null);
      if (loadResult) {
        const { session, source } = loadResult;
        this.auditWriter.write('session_loaded', `source=${source}`);
        const auditAbsPath = this.systemFs.resolve('audit.tsv');
        const interruptionMessage = summarizeLastExit(auditAbsPath);
        const { repaired, toolCount } = SessionManager.repair(
          session.messages,
          interruptionMessage ? { interruptionMessage } : undefined,
        );
        if (toolCount > 0) {
          await this.sessionManager.save(repaired);
          this.auditWriter.write('session_repaired', `tools=${toolCount}`);
          void this.snapshot.commit(`session-repair tools=${toolCount}`);
        }
      }
    }

    // 7. Create ToolRegistry and register built-in tools
    this.toolRegistry = new ToolRegistry();
    registerBuiltinTools(this.toolRegistry);
    // dispatch 需要构造参数，单独注册
    this.toolRegistry.register(new DispatchTool(
      () => this.buildSystemPrompt(),           // 每个 Claw 用自己的 system prompt
      () => this.toolRegistry.formatForLLM(this.toolRegistry.getAll()),  // Motion 完整工具列表
      (profile) => this.toolRegistry.formatForLLM(this.toolRegistry.getForProfile(profile as import('../types/config.js').ToolProfile)),  // 按 profile 获取工具列表
    ));

    // 8. Create TaskSystem
    this.taskSystem = new TaskSystem(clawDir, this.systemFs, {
      maxConcurrent: this.options.maxConcurrentTasks,
      auditWriter: this.auditWriter,
    });
    await this.taskSystem.initialize();
    this.taskSystem.setLLMService(this.llm);
    // Restored tasks can only be dispatched after the LLM service is set
    this.taskSystem.startDispatch();

    // 9. Create SkillRegistry (lazy-loads skills)
    this.skillRegistry = new SkillRegistry(this.systemFs, 'skills');
    await this.skillRegistry.loadAll();

    // 10. Create ContractManager (with LLM and verifier registry for acceptance)
    const verifierRegistry = new ToolRegistry();
    for (const tool of this.toolRegistry.getForProfile('verifier')) {
      verifierRegistry.register(tool);
    }
    const motionInboxDir = path.join(workspaceDir, 'motion', 'inbox', 'pending');
    this.contractManager = new ContractManager(
      clawDir, clawId, this.systemFs, this.monitor, this.llm, verifierRegistry, motionInboxDir,
      this.auditWriter,
    );

    // 11. Create ContextInjector (inject skillRegistry and contractManager)
    this.contextInjector = new ContextInjector({
      fs: this.systemFs,
      skillRegistry: this.skillRegistry,
      contractManager: this.contractManager,
    });

    // 12. Create OutboxWriter first (needed by ExecContextImpl)
    this.outboxWriter = new OutboxWriter(clawId, clawDir, this.systemFs);

    // Inject late-created dependencies into TaskSystem (created before SkillRegistry/ContractManager/OutboxWriter)
    this.taskSystem.setSkillRegistry(this.skillRegistry);
    this.taskSystem.setContractManager(this.contractManager);
    this.taskSystem.setOutboxWriter(this.outboxWriter);

    // 13. Create ExecContextImpl (inject all dependencies; tools use clawFs)
    this.execContext = new ExecContextImpl({
      clawId,
      clawDir,
      profile: toolProfile!,
      callerType: 'claw',
      fs: this.clawFs,
      monitor: this.monitor,
      llm: this.llm,
      maxSteps,
      taskSystem: this.taskSystem,
      skillRegistry: this.skillRegistry,
      contractManager: this.contractManager,
      subagentMaxSteps: this.options.subagentMaxSteps,
      outboxWriter: this.outboxWriter,
      auditWriter: this.auditWriter,
    });

    // 14. Create ToolExecutorImpl
    this.toolExecutor = new ToolExecutorImpl(this.toolRegistry, this.options.toolTimeoutMs);

    // 15. Create InboxReader
    this.inboxReader = new InboxReader('inbox/pending', 'inbox/done', 'inbox/failed', this.systemFs, this.auditWriter);
    await this.inboxReader.init();

    this.initialized = true;
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
   * Format a relative time string from an ISO8601 timestamp.
   */
  private formatTimeAgo(timestamp: string): string {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) return '';
    const s = Math.floor(diffMs / 1_000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /**
   * Format the injection text for an inbox message by its type.
   * user_chat: no prefix (user typed in the chat)
   * user_inbox_message: [user inbox message] prefix (user sent a message via CLI)
   * system events: [system message] prefix
   */
  protected async formatInboxMessage(type: string, from: string, body: string, timestamp?: string): Promise<string> {
    const ago = timestamp ? this.formatTimeAgo(timestamp) : '';
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
    const entries = await this.inboxReader.drainInbox();
    if (entries.length === 0) {
      return { injected: [], sources: [], count: 0, infos: [] };
    }

    const addressed: typeof entries = [];
    const unaddressed: typeof entries = [];
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
        'inbox_inject',
        `file=${path.basename(filePath)}`,
        `type=${message.type}`,
        `from=${message.from}`,
        `to=${message.to || this.options.clawId}`,
        `pri=${message.priority}`,
      );
    }
    for (const { message, filePath } of unaddressed) {
      this.auditWriter.write(
        'inbox_unaddressed',
        `file=${path.basename(filePath)}`,
        `type=${message.type}`,
        `from=${message.from}`,
        `to=${message.to}`,
      );
    }

    for (const { filePath } of [...addressed, ...unaddressed]) {
      await this.inboxReader.markDone(filePath);
    }

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

    return {
      injected,
      sources,
      count: addressed.length,
      infos: addressed.map(e => e.message),
    };
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
    const systemPrompt = await this.buildSystemPrompt();

    // Idle timeout: abort if no token output for idleTimeoutMs (0 = disabled)
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS;
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = idleTimeoutMs > 0 ? () => {
      clearTimeout(idleTimerId);
      idleTimerId = setTimeout(
        () => this.currentAbortController?.abort({ type: 'idle_timeout', ms: idleTimeoutMs }),
        idleTimeoutMs
      );
    } : undefined;
    resetIdle?.();

    // 首个 LLM 输出 delta 时上报当前生效的 provider（确认 API 可用后才显示）
    let providerInfoEmitted = false;
    const emitProviderInfoOnce = () => {
      if (!providerInfoEmitted) {
        providerInfoEmitted = true;
        callbacks?.onProviderInfo?.(this.llm.getProviderInfo());
      }
    };

    // Wrap onToolResult to write audit event
    const origOnToolResult = callbacks?.onToolResult;
    const auditOnToolResult = (
      name: string, toolUseId: string,
      result: ToolResult, step: number, maxSteps: number
    ) => {
      this.auditWriter.write(
        'tool_result', name, toolUseId,
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
        onLLMResult: (info) => {
          if (info.error) {
            this.auditWriter.write('llm_error', info.model, `err=${info.error}`, `ms=${info.latencyMs}`);
          } else {
            this.auditWriter.write('llm_call', info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `ms=${info.latencyMs}`);
          }
        },
        onStepComplete: async () => {
          await this.sessionManager.save(messages);
          // 步间检查：高优先级消息到达时提前结束本轮
          if (await this._hasHighPriorityInbox()) {
            this.currentAbortController?.abort({ type: 'step_yield' });
          }
        },
        onTextDelta: (d) => { resetIdle?.(); emitProviderInfoOnce(); callbacks?.onTextDelta?.(d); },
        onTextEnd: callbacks?.onTextEnd,
        onThinkingDelta: (d) => { resetIdle?.(); emitProviderInfoOnce(); callbacks?.onThinkingDelta?.(d); },
        onToolCall: (n, id) => { resetIdle?.(); callbacks?.onToolCall?.(n, id); },
        onToolResult: auditOnToolResult,
        onBeforeLLMCall: () => { resetIdle?.(); callbacks?.onBeforeLLMCall?.(); },
        onReset: (provider, timeoutMs) => {
          resetIdle?.();
          providerInfoEmitted = false;
          callbacks?.onProviderFailover?.({ from: provider, timeoutMs });
        },
        onProviderFailed: (provider, model, error) => {
          callbacks?.onProviderFailed?.({ provider, model, error });
        },
      });
    } finally {
      clearTimeout(idleTimerId);
    }
    await this.sessionManager.save(messages);

    // turn auto-commit（fire-and-forget）
    this.turnCount++;
    void this.snapshot.commit(`turn-${this.turnCount} ${new Date().toISOString()}`);
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
        console.warn('[runtime] onInboxMessages handler failed:', e instanceof Error ? e.message : String(e));
      }
    }

    const { session } = await this.sessionManager.load();
    const messages = [...session.messages, ...injected];

    // Save injected messages immediately so interrupt doesn't lose them
    await this.sessionManager.save(messages);

    // Turn start: inbox drained and persisted, processing about to begin
    callbacks?.onTurnStart?.(sources);
    this.auditWriter.write('turn_start');

    // AbortController support (same as chat() mode)
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    try {
      await this._runReact(messages, callbacks);

      // Turn completed normally
      callbacks?.onTurnEnd?.();
      this.auditWriter.write('turn_end');

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
          const sender = info.from;
          if (sender) {
            await this.outboxWriter.write({
              type: 'response',
              to: sender,
              content: `Error: ${errorMsg}`,
              contract_id: info.contract_id,
            }).catch(e => console.error('[runtime] Failed to write error response:', e));
          }
        }
      } else if (!(err instanceof PriorityInboxInterrupt || err instanceof UserInterrupt || err instanceof IdleTimeoutSignal)) {
        // Non-interrupt error (LLM crash, tool error, etc.) — notify senders
        const errorMsg = err instanceof Error ? err.message : String(err);
        for (const info of infos) {
          const sender = info.from;
          if (sender) {
            await this.outboxWriter.write({
              type: 'response',
              to: sender,
              content: `Error: ${errorMsg}`,
              contract_id: info.contract_id,
            }).catch(e => console.error('[runtime] Failed to write error response:', e));
          }
        }
      }
      // Log unexpected errors to audit (aborts and MaxSteps are expected control flow)
      if (
        !(err instanceof PriorityInboxInterrupt || err instanceof UserInterrupt || err instanceof IdleTimeoutSignal) &&
        !(err instanceof MaxStepsExceededError)
      ) {
        this.monitor?.log('error', {
          context: 'Runtime.processBatch',
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
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
    this.auditWriter.write('turn_start');

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    try {
      await this._runReact(messages, callbacks);
      this.auditWriter.write('turn_end');
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
    this.auditWriter.write('turn_start');

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.execContext.signal = abortController.signal;
    try {
      await this._runReact(retryMessages, callbacks);
      callbacks?.onTurnEnd?.();
      this.auditWriter.write('turn_end');
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
    const systemPrompt = await this.buildSystemPrompt();

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

    let chatProviderInfoEmitted = false;
    const emitChatProviderInfoOnce = () => {
      if (!chatProviderInfoEmitted) {
        chatProviderInfoEmitted = true;
        options?.onProviderInfo?.(this.llm.getProviderInfo());
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
        onLLMResult: (info) => {
          if (info.error) {
            this.auditWriter.write('llm_error', info.model, `err=${info.error}`, `ms=${info.latencyMs}`);
          } else {
            this.auditWriter.write('llm_call', info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `ms=${info.latencyMs}`);
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

      // Return the final text
      return result.finalText;
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
      this.auditWriter.write('turn_interrupted', 'cause=idle_timeout', `ms=${err.timeoutMs}`);
    } else if (err instanceof PriorityInboxInterrupt) {
      callbacks?.onTurnInterrupted?.('priority_inbox', 'Interrupted (priority inbox)');
      this.auditWriter.write('turn_interrupted', 'cause=priority_inbox');
    } else if (err instanceof UserInterrupt) {
      callbacks?.onTurnInterrupted?.('user_interrupt');  // 不传 message，让 viewport 自行决定显示
      this.auditWriter.write('turn_interrupted', 'cause=user_interrupt');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      callbacks?.onTurnError?.(errorMsg);
      this.auditWriter.write('turn_error', `err=${errorMsg}`);
    }
  }

  /**
   * Check if inbox has high/critical priority messages
   */
  private async _hasHighPriorityInbox(): Promise<boolean> {
    const pendingDir = path.join(this.options.clawDir, 'inbox', 'pending');
    let files: string[];
    try {
      files = (await fs.readdir(pendingDir)).filter(f => f.endsWith('.md'));
    } catch {
      return false;
    }
    for (const file of files) {
      const meta = readInboxFileMeta(this.systemFs, path.join(pendingDir, file));
      if (meta?.priority === 'high' || meta?.priority === 'critical') return true;
    }
    return false;
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
   * Get TaskSystem instance (for retrospective scheduling)
   */
  getTaskSystem(): TaskSystem {
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
    return this.contextInjector.buildSystemPrompt();
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private async ensureDirectories(clawDir: string): Promise<void> {
    // Use the shared constant (consistent with createCommand)
    // Use Node fs directly to create directories (NodeFileSystem is not yet initialized)
    const { promises: nodeFs } = await import('fs');
    for (const dir of CLAW_SUBDIRS) {
      await nodeFs.mkdir(path.join(clawDir, dir), { recursive: true });
    }
  }

  /**
   * Set callback for contract notifications (subtask_completed, acceptance_failed, etc.)
   */
  setContractNotifyCallback(cb: (type: string, data: Record<string, unknown>) => void): void {
    this.contractManager?.setOnNotify(cb);
  }

  setParentStreamSink(sink: import('../foundation/stream/types.js').StreamSink): void {
    this.taskSystem?.setParentStreamSink(sink);
  }

  getAuditWriter(): AuditWriter {
    return this.auditWriter;
  }

}
