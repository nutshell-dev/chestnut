/**
 * SubAgent - Independent ReAct agent for delegated tasks
 * 
 * SubAgent runs with restricted permissions and cannot spawn other agents.
 */

import { runReact } from '../agent-executor/index.js';
import { ToolExecutor } from '../../foundation/tools/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ToolDefinition } from '../../foundation/llm-provider/types.js';
import { ToolTimeoutError } from '../../foundation/errors.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../signals.js';
import type { AbortReason } from '../../foundation/llm-provider/index.js';
import { makeExternalAbortError } from '../../foundation/llm-provider/index.js';
import { SUBAGENT_TIMEOUT_MS } from './constants.js';
import { oneLine } from '../../foundation/utils/format.js';
import type { Message } from '../../foundation/llm-provider/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { SUBAGENT_AUDIT_EVENTS, REACT_LOOP_AUDIT_EVENTS } from './audit-events.js';
import { AGENT_STREAM_EVENTS } from '../agent-executor/index.js';
import type { StreamLog } from '../../foundation/stream/index.js';
import { type CallerType, callerTypeToProfile, CALLER_TYPE_TO_GROUPS } from '../caller-types.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../prompts/index.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';



export interface SubAgentOptions {
  agentId: string;
  resultDir: string;        // phase443: caller 注入完整 path（如 `tasks/results/${task.id}`）/ SubAgent 0 知字符串约定
  messageStore: DialogStore;             // phase453: caller 装配期注入 ephemeral DialogStore（filename='messages.json' / 0 clawId / 0 archive 触发）
  prompt: string;
  clawDir: string;
  syncDir: string;
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  maxSteps: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  toolsForLLM?: ToolDefinition[];  // Pre-filtered tool list for LLM, overrides registry.getAll()
  idleTimeoutMs?: number;
  onIdleTimeout?: () => void;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  systemPrompt?: string;                    // 替换 run() 里硬编码的默认 system prompt
  workspaceDir: string;            // phase 512 / 子代理 cwd / 装配方注入 tasks/subagents/<task-id>/
  callerType?: CallerType;  // 默认 'subagent'
  subagentMaxSteps?: number;                 // 传给子 SubAgent
  messages?: Message[];                      // 若提供，直接用；否则从 prompt 构建
  originClawId?: string;                     // 创建链路源头，传给子 SubAgent
  isShadow?: boolean;                         // phase 767：shadow 分身标记
  toolTimeoutMs?: number;                      // phase 1029 / F-2: tool-level timeout inheritance
  taskStreamWriter: StreamLog;
  auditWriter: AuditLog;          // tasks/queues/results/{id}/audit.tsv，step 11+ 写事件
  permissionChecker?: PermissionChecker;                      // phase 1072: subagent file tool permission check
}

export class SubAgent {
  private agentId: string;
  private resultDir: string;
  private messageStore: DialogStore;
  private prompt: string;
  private clawDir: string;
  private syncDir: string;
  private llm: LLMOrchestrator;
  private registry: ToolRegistry;
  private fs: FileSystem;
  private fsFactory?: (baseDir: string) => FileSystem;
  private maxSteps: number;
  private maxConsecutiveParseErrors?: number;
  private maxConsecutiveMaxTokensToolUse?: number;
  private timeoutMs: number;
  private signal?: AbortSignal;
  private logPath: string;
  private toolsForLLM?: ToolDefinition[];
  private idleTimeoutMs?: number;
  private onIdleTimeout?: () => void;
  private systemPrompt?: string;
  private workspaceDir: string;
private callerType?: CallerType;
  private subagentMaxSteps?: number;
  private messages?: Message[];
  private originClawId?: string;
  private isShadow?: boolean;
  private toolTimeoutMs?: number;
  private taskStreamWriter: StreamLog;
  private auditWriter: AuditLog;
  private permissionChecker?: PermissionChecker;


  constructor(options: SubAgentOptions) {
    this.agentId = options.agentId;
    this.resultDir = options.resultDir;
    this.messageStore = options.messageStore;
    this.prompt = options.prompt;
    this.clawDir = options.clawDir;
    this.syncDir = options.syncDir;
    this.llm = options.llm;
    this.registry = options.registry;
    this.fs = options.fs;
    this.fsFactory = options.fsFactory;
    this.maxSteps = options.maxSteps;
    this.maxConsecutiveParseErrors = options.maxConsecutiveParseErrors;
    this.maxConsecutiveMaxTokensToolUse = options.maxConsecutiveMaxTokensToolUse;
    this.timeoutMs = options.timeoutMs ?? SUBAGENT_TIMEOUT_MS; // 5 min default
    this.signal = options.signal;
    this.logPath = `${this.resultDir}/daemon.log`;
    this.toolsForLLM = options.toolsForLLM;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onIdleTimeout = options.onIdleTimeout;
    this.systemPrompt = options.systemPrompt;
    this.workspaceDir = options.workspaceDir;
    this.callerType = options.callerType;
    this.subagentMaxSteps = options.subagentMaxSteps;
    this.messages = options.messages;
    this.originClawId = options.originClawId;
    this.isShadow = options.isShadow;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.taskStreamWriter = options.taskStreamWriter;
    this.auditWriter = options.auditWriter;
    this.permissionChecker = options.permissionChecker;
  }

  /**
   * Run the subagent and return final text result
   */
  async run(): Promise<string> {
    const startTime = Date.now();
    
    // Stream writer for per-task stream.jsonl
    const sw = this.taskStreamWriter;
    
    // Create timeout controller
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort({ type: 'turn_timeout', ms: this.timeoutMs } satisfies AbortReason);
    }, this.timeoutMs);

    // Idle timeout: abort if no LLM activity for idleTimeoutMs
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = this.idleTimeoutMs
      ? () => {
          clearTimeout(idleTimerId);
          idleTimerId = setTimeout(() => {
            try {
              this.onIdleTimeout?.();
            } catch { /* silent: callback failure must not block abort */ }
            timeoutController.abort({ type: 'idle_timeout', ms: this.idleTimeoutMs! } satisfies AbortReason);
          }, this.idleTimeoutMs!);
        }
      : undefined;

    // 立即启动 idle 计时（等待第一个 chunk）
    resetIdle?.();

    // Combine with external signal if provided
    const onExternalAbort = () => {
      timeoutController.abort(this.signal!.reason);
    };
    if (this.signal) {
      this.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let turnEnded = false;
    let swClosed = false;
    let ghostAuditEmitted = false;
    const closeSw = () => { swClosed = true; };
    const safeSwWrite = (event: import('../../foundation/stream/types.js').StreamEvent) => {
      if (swClosed) {
        if (!ghostAuditEmitted) {
          ghostAuditEmitted = true;
          this.auditWriter.write(
            SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END,
            `agentId=${this.agentId}`,
            `event=${event.type}`,
          );
        }
        return;
      }
      sw.write(event);
    };

    // Turn start: written before any potentially-throwing init so catch always pairs it
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_START });
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    try {
      const callerType = this.callerType ?? 'subagent';
      const executorProfile = callerTypeToProfile(callerType);
      const executor = new ToolExecutor({
        registry: this.registry,
        defaultTimeoutMs: this.toolTimeoutMs,   // NEW phase 1029 / F-2
        clawDir: this.clawDir,
        syncDir: this.syncDir,
        workspaceDir: this.workspaceDir,   // phase 512
        fs: this.fs,
        fsFactory: this.fsFactory,
        llm: this.llm,
        subagentMaxSteps: this.subagentMaxSteps ?? this.maxSteps,
        auditWriter: this.auditWriter,
      });

      // Setup messages（若传入 messages 则直接使用，否则从 prompt 构建）
      // Store on this.messages so finally block can persist the mutated array
      if (this.messages) {
        if (this.prompt) {
          this.messages.push({ role: 'user' as const, content: this.prompt });
        }
      } else {
        this.messages = [{ role: 'user' as const, content: this.prompt }];
      }
      const messages = this.messages;

      // Ensure task directory exists
      await this.fs.ensureDir(this.resultDir);

      // Log start
      await this.appendToLog(`=== SubAgent ${this.agentId} started ===\n`);
      await this.appendToLog(`Prompt: ${this.prompt}\n`);

      // Step audit state (reset each step)
      let auditStep = 0;
      let auditStepTools: string[] = [];
      let auditStepStart = Date.now();
      const stepsLogPath = `${this.resultDir}/steps.jsonl`;

      // System prompt for subagent (use custom or default from prompts module)
      const systemPrompt = this.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;

      // Format tools for LLM native tool_use (use pre-filtered list if provided)
      const tools = this.toolsForLLM
        ?? this.registry.formatForLLM(this.registry.getAll());

      // Run ReAct loop，用 Promise.race 强制超时退出
      // Tool 层超时通过 timeoutController.signal 传到 ctx.signal；LLM stream
      // (collectStreamResponse) 也消费 ctx.signal，fetch/SDK 会实际取消请求
      // (见 src/foundation/llm-provider/abort-helper.ts)。race 保留为最外层保险：若某
      // provider 未正确响应 signal，timeoutController 胜出时本 Promise 立即抛
      // ToolTimeoutError，不等 LLM 自然结束。
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutController.signal.addEventListener('abort', () => {
          const r = timeoutController.signal.reason as AbortReason | undefined;
          if (r?.type === 'turn_timeout') {
            reject(new ToolTimeoutError('subagent_run', r.ms));
          } else if (r?.type === 'idle_timeout') {
            reject(new IdleTimeoutSignal(r.ms));
          } else if (r?.type === 'user') {
            reject(new UserInterrupt());
          } else if (r?.type === 'step_yield') {
            reject(new PriorityInboxInterrupt());
          } else {
            reject(makeExternalAbortError(r));
          }
        }, { once: true });
      });
      timeoutPromise.catch((e) => {
        this.auditWriter.write(
          SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION,
          `agentId=${this.agentId}`,
          `reason=${e instanceof Error ? e.message : String(e)}`,
        );
      });

      // Stream writer callbacks for per-task stream.jsonl
      const streamCallbacks = {
        onBeforeLLMCall: () => {
          safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.LLM_START });
        },
        onTextDelta: (delta: string) => {
          safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TEXT_DELTA, delta });
        },
        onThinkingDelta: (delta: string) => {
          safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.THINKING_DELTA, delta });
        },
        onTextEnd: () => {
          safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TEXT_END });
        },
        onToolCall: (name: string, toolUseId: ToolUseId) => {
          safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TOOL_CALL, name, tool_use_id: toolUseId });
        },
        onToolResult: (name: string, toolUseId: ToolUseId, result: { success: boolean; content?: string }, step: number, maxSteps: number) => {
          this.auditWriter.write(
            'tool_result', name, toolUseId,
            result.success ? 'ok' : 'err',
            `summary=${oneLine(result.content ?? '')}`,
          );
          safeSwWrite({
            ts: Date.now(),
            type: AGENT_STREAM_EVENTS.TOOL_RESULT,
            name,
            tool_use_id: toolUseId,
            success: result.success,
            summary: oneLine(result.content ?? ''),
            step: step + 1,
            maxSteps,
          });
        },
      };

      const result = await Promise.race([
        runReact({
          messages,
          systemPrompt,
          llm: this.llm,
          executor,
          ctx: executor.getExecContext(executorProfile, {
            clawId: makeClawId(this.agentId),
            maxSteps: this.maxSteps,
            signal: timeoutController.signal,
            allowedGroups: CALLER_TYPE_TO_GROUPS[callerType],
            callerLabel: callerType,
            originClawId: this.originClawId,
            isShadow: this.isShadow,
            permissionChecker: this.permissionChecker,
          }),
          maxSteps: this.maxSteps,
          maxConsecutiveParseErrors: this.maxConsecutiveParseErrors,
          maxConsecutiveMaxTokensToolUse: this.maxConsecutiveMaxTokensToolUse,
          registry: this.registry,  // Enable parallel execution for readonly tools
          tools,                    // Enable native tool_use
          onLLMResult: (info) => {
            if (info.error) {
              this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_ERROR, info.model, `error=${info.error}`, `latency_ms=${info.latencyMs}`);
            } else {
              this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.LLM_CALL, info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `latency_ms=${info.latencyMs}`);
            }
          },
          onBeforeLLMCall: streamCallbacks.onBeforeLLMCall,
          onTextDelta: (delta: string) => { resetIdle?.(); streamCallbacks.onTextDelta?.(delta); },
          onThinkingDelta: (delta: string) => { resetIdle?.(); streamCallbacks.onThinkingDelta?.(delta); },
          onTextEnd: streamCallbacks.onTextEnd,
          onToolCall: async (name, toolUseId) => {
            resetIdle?.();
            streamCallbacks.onToolCall?.(name, toolUseId);
            auditStepTools.push(name);
            await this.appendToLog(`Tool called: ${name}\n`);
          },
          onToolResult: (name, toolUseId, result, step, maxSteps) => {
            streamCallbacks.onToolResult?.(name, toolUseId, result, step, maxSteps);
          },
          onUnparseableToolUse: () => {},
          onStepComplete: async () => {
            try {
              const entry = JSON.stringify({
                step: auditStep,
                ts: new Date().toISOString(),
                tools: auditStepTools,
                elapsedMs: Date.now() - auditStepStart,
              });
              await this.fs.append(stepsLogPath, entry + '\n');
            } catch (err) {
              this.auditWriter.write(
                SUBAGENT_AUDIT_EVENTS.STEP_COMPLETE_FAILED,
                `agentId=${this.agentId}`,
                `error=${err instanceof Error ? err.message : String(err)}`,
              );
              // 不 throw — audit 失败不终止任务
            }
            // 每步后持久化 messages — 崩溃可恢复、执行中可观察
            try {
              await this.messageStore.save({
                systemPrompt,
                messages,
                toolsForLLM: tools,
              });
            } catch (err) {
              this.auditWriter.write(
                SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED,
                `agentId=${this.agentId}`,
                `error=${err instanceof Error ? err.message : String(err)}`,
              );
              // 不 throw — 持久化失败不终止任务
            }
            auditStep++;
            auditStepTools = [];
            auditStepStart = Date.now();
          },
        }),
        timeoutPromise,
      ]);

      // race 结束：若 runReact 先完成，abort 释放挂起的 timeout/idle promise 引用
      timeoutController.abort();
      clearTimeout(idleTimerId);

      // Log completion
      const duration = Date.now() - startTime;
      await this.appendToLog(`=== Completed in ${duration}ms ===\n`);
      await this.appendToLog(`Stop reason: ${result.stopReason}\n`);
      await this.appendToLog(`Final text: ${result.finalText}\n`);

      safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_END });
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);
      turnEnded = true;

      // Extract final text result
      return result.finalText ?? '[No output produced]';
    } catch (error) {
      // Log error
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.appendToLog(`=== Error: ${errMsg} ===\n`);

      if (error instanceof ToolTimeoutError) {
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: `Timeout after ${this.timeoutMs}ms` });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=turn_timeout', `turn_timeout_ms=${this.timeoutMs}`);
      } else if (error instanceof IdleTimeoutSignal) {
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: `Idle timeout after ${error.timeoutMs}ms` });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${error.timeoutMs}`);
      } else if (error instanceof UserInterrupt) {
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: 'User interrupt' });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
      } else if (error instanceof PriorityInboxInterrupt) {
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: 'Priority inbox' });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
      } else if ((error as Error)?.name === 'AbortError') {
        const cause = (error as Error & { cause?: AbortReason }).cause;
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: errMsg });
        this.auditWriter.write(
          REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED,
          'cause=external',
          ...(cause ? [`type=${cause.type}`] : []),
        );
      } else {
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_ERROR, error: errMsg });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${errMsg}`);
      }
      turnEnded = true;
      closeSw();

      throw error;
    } finally {
      // 统一清理所有 timer，避免内存泄漏
      clearTimeout(timeoutId);
      clearTimeout(idleTimerId);
      // Cleanup external signal listener (if signal never fired, removeEventListener prevents leak)
      this.signal?.removeEventListener('abort', onExternalAbort);
      // Safety net: write turn_end only if no specific turn end event was already written
      if (!turnEnded) {
        safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_END });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);
        closeSw();
      }
      // 持久化 messages — finally 保证超时/中断/正常结束都落盘（best-effort）
      try {
        await this.messageStore.save({
          systemPrompt: this.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT,
          messages: this.messages ?? [],
          toolsForLLM: this.toolsForLLM ?? [],
        });
      } catch (e) {
        this.auditWriter.write(
          SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED,
          `agentId=${this.agentId}`,
          `error=${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Append to log file (atomic append, no read-modify-write race)
   */
  private async appendToLog(text: string): Promise<void> {
    try {
      // 使用 FileSystem.append 实现原子追加，避免竞态
      await this.fs.append(this.logPath, text);
    } catch (e) {
      // Log failures are non-fatal
      this.auditWriter.write(
        SUBAGENT_AUDIT_EVENTS.LOG_APPEND_FAILED,
        `agentId=${this.agentId}`,
        `error=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
