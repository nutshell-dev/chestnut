/**
 * SubAgent - Independent ReAct agent for delegated tasks
 * 
 * SubAgent runs with restricted permissions and cannot spawn other agents.
 */

import { runReact } from '../react/loop.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistryImpl } from '../tools/registry.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMService } from '../../foundation/llm/index.js';
import type { ToolDefinition } from '../../types/message.js';
import { ToolTimeoutError } from '../../types/errors.js';
import { SUBAGENT_TIMEOUT_MS, DEFAULT_MAX_STEPS } from '../../constants.js';
import { oneLine } from '../../types/utils.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../prompts/index.js';
import type { TaskScheduler } from '../tools/task-scheduler.js';
import type { Message } from '../../types/message.js';
import type { Audit } from '../../foundation/audit/index.js';
import type { AuditWriter } from '../../foundation/audit/writer.js';
import { AUDIT_EVENTS } from '../../foundation/audit/events.js';
import type { StreamLog } from '../../foundation/stream/types.js';
import type { CallerType } from '../tools/caller-type.js';
import { callerTypeToProfile } from '../tools/caller-type.js';

export interface SubAgentOptions {
  agentId: string;
  prompt: string;
  clawDir: string;
  llm: LLMService;
  registry: ToolRegistryImpl;
  fs: FileSystem;
  audit?: AuditWriter;
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  toolsForLLM?: ToolDefinition[];  // Pre-filtered tool list for LLM, overrides registry.getAll()
  idleTimeoutMs?: number;
  onIdleTimeout?: () => void;
  systemPrompt?: string;                    // 替换 run() 里硬编码的默认 system prompt
  callerType?: CallerType;  // 默认 'subagent'
  taskSystem?: TaskScheduler;               // dispatch tool addTaskResultHandler 路径需要；透传至 ToolExecutor / ExecContext。phase163 起不再供调度用途。
  subagentMaxSteps?: number;                 // 传给子 SubAgent
  messages?: Message[];                      // 若提供，直接用；否则从 prompt 构建
  originClawId?: string;                     // 创建链路源头，传给子 SubAgent
  taskStreamWriter: StreamLog;
  auditWriter: Audit;          // tasks/results/{id}/audit.tsv，step 11+ 写事件
}

export class SubAgent {
  private agentId: string;
  private prompt: string;
  private clawDir: string;
  private llm: LLMService;
  private registry: ToolRegistryImpl;
  private fs: FileSystem;
  private audit?: AuditWriter;
  private maxSteps: number;
  private timeoutMs: number;
  private signal?: AbortSignal;
  private logPath: string;
  private toolsForLLM?: ToolDefinition[];
  private idleTimeoutMs?: number;
  private onIdleTimeout?: () => void;
  private systemPrompt?: string;
  private callerType?: CallerType;
  /** @see SubAgentOptions.taskSystem */
  private taskSystem?: TaskScheduler;
  private subagentMaxSteps?: number;
  private messages?: Message[];
  private originClawId?: string;
  private taskStreamWriter: StreamLog;
  private auditWriter: Audit;

  constructor(options: SubAgentOptions) {
    this.agentId = options.agentId;
    this.prompt = options.prompt;
    this.clawDir = options.clawDir;
    this.llm = options.llm;
    this.registry = options.registry;
    this.fs = options.fs;
    this.audit = options.audit;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.timeoutMs = options.timeoutMs ?? SUBAGENT_TIMEOUT_MS; // 5 min default
    this.signal = options.signal;
    this.logPath = `tasks/results/${this.agentId}/daemon.log`;
    this.toolsForLLM = options.toolsForLLM;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onIdleTimeout = options.onIdleTimeout;
    this.systemPrompt = options.systemPrompt;
    this.callerType = options.callerType;
    this.taskSystem = options.taskSystem;
    this.subagentMaxSteps = options.subagentMaxSteps;
    this.messages = options.messages;
    this.originClawId = options.originClawId;
    this.taskStreamWriter = options.taskStreamWriter;
    this.auditWriter = options.auditWriter;
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
      timeoutController.abort();
    }, this.timeoutMs);

    // Idle timeout: abort if no LLM activity for idleTimeoutMs
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = this.idleTimeoutMs
      ? () => {
          clearTimeout(idleTimerId);
          idleTimerId = setTimeout(() => {
            this.onIdleTimeout?.();
            timeoutController.abort();
          }, this.idleTimeoutMs!);
        }
      : undefined;

    // 立即启动 idle 计时（等待第一个 chunk）
    resetIdle?.();

    // Combine with external signal if provided
    if (this.signal) {
      this.signal.addEventListener('abort', () => {
        timeoutController.abort();
      }, { once: true });
    }

    let turnEnded = false;

    // Turn start: written before any potentially-throwing init so catch always pairs it
    sw.write({ ts: Date.now(), type: 'turn_start' });
    this.auditWriter.write('turn_start');

    try {
      const callerType = this.callerType ?? 'subagent';
      const executorProfile = callerTypeToProfile(callerType);
      const executor = new ToolExecutor({
        registry: this.registry,
        clawDir: this.clawDir,
        fs: this.fs,
        llm: this.llm,
        taskSystem: this.taskSystem,
        subagentMaxSteps: this.subagentMaxSteps ?? this.maxSteps,
        profile: executorProfile,
        auditWriter: this.auditWriter,
      });

      // Setup messages（若传入 messages 则直接使用，否则从 prompt 构建）
      const messages: Message[] = this.messages
        ? [
            ...this.messages,  // 继承历史上下文
            ...(this.prompt ? [{ role: 'user' as const, content: this.prompt }] : []),
          ]
        : [{ role: 'user' as const, content: this.prompt }];

      // Ensure task directory exists
      await this.fs.ensureDir(`tasks/results/${this.agentId}`);

      // Log start
      await this.appendToLog(`=== SubAgent ${this.agentId} started ===\n`);
      await this.appendToLog(`Prompt: ${this.prompt}\n`);

      // Step audit state (reset each step)
      let auditStep = 0;
      let auditStepTools: string[] = [];
      let auditStepStart = Date.now();
      const stepsLogPath = `tasks/results/${this.agentId}/steps.jsonl`;

      // System prompt for subagent (use custom or default from prompts module)
      const systemPrompt = this.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;

      // Format tools for LLM native tool_use (use pre-filtered list if provided)
      const tools = this.toolsForLLM
        ?? this.registry.formatForLLM(this.registry.getAll());

      // Run ReAct loop，用 Promise.race 强制超时退出
      // Tool 层超时通过 timeoutController.signal 传到 ctx.signal；LLM stream
      // (collectStreamResponse) 也消费 ctx.signal，fetch/SDK 会实际取消请求
      // (见 src/foundation/llm/abort-helper.ts)。race 保留为最外层保险：若某
      // provider 未正确响应 signal，timeoutController 胜出时本 Promise 立即抛
      // ToolTimeoutError，不等 LLM 自然结束。
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutController.signal.addEventListener('abort', () => {
          reject(new ToolTimeoutError('subagent_run', this.timeoutMs));
        }, { once: true });
      });
      timeoutPromise.catch(() => {}); // 防止 race 胜出后的孤立 rejection

      // Stream writer callbacks for per-task stream.jsonl
      const streamCallbacks = {
        onBeforeLLMCall: () => {
          sw.write({ ts: Date.now(), type: 'llm_start' });
        },
        onTextDelta: (delta: string) => {
          sw.write({ ts: Date.now(), type: 'text_delta', delta });
        },
        onThinkingDelta: (delta: string) => {
          sw.write({ ts: Date.now(), type: 'thinking_delta', delta });
        },
        onTextEnd: () => {
          sw.write({ ts: Date.now(), type: 'text_end' });
        },
        onToolCall: (name: string, toolUseId: string) => {
          sw.write({ ts: Date.now(), type: 'tool_call', name, tool_use_id: toolUseId });
        },
        onToolResult: (name: string, toolUseId: string, result: { success: boolean; content?: string }, step: number, maxSteps: number) => {
          sw.write({
            ts: Date.now(),
            type: 'tool_result',
            name,
            tool_use_id: toolUseId,
            success: result.success,
            summary: oneLine(result.content ?? ''),
            step: step + 1,
            maxSteps,
          });
          this.auditWriter.write(
            'tool_result', name, toolUseId,
            result.success ? 'ok' : 'err',
            `summary=${oneLine(result.content ?? '')}`,
          );
        },
      };

      const result = await Promise.race([
        runReact({
          messages,
          systemPrompt,
          llm: this.llm,
          executor,
          ctx: executor.getExecContext(executorProfile, {
            clawId: this.agentId,
            signal: timeoutController.signal,
            callerType,
            originClawId: this.originClawId,
          }),
          maxSteps: this.maxSteps,
          registry: this.registry,  // Enable parallel execution for readonly tools
          tools,                    // Enable native tool_use
          onLLMResult: (info) => {
            if (info.error) {
              this.auditWriter.write('llm_error', info.model, `err=${info.error}`, `ms=${info.latencyMs}`);
            } else {
              this.auditWriter.write('llm_call', info.model, `in=${info.inputTokens}`, `out=${info.outputTokens}`, `ms=${info.latencyMs}`);
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
              this.audit?.write(
                AUDIT_EVENTS.SUBAGENT_STEP_COMPLETE_FAILED,
                `agentId=${this.agentId}`,
                `error=${err instanceof Error ? err.message : String(err)}`,
              );
              // 不 throw — audit 失败不终止任务
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

      // 持久化 messages 供复盘子代理继承（best-effort，不影响主流程）
      try {
        await this.fs.writeAtomic(
          `tasks/results/${this.agentId}/messages.json`,
          JSON.stringify(messages),
        );
      } catch (e) {
        this.audit?.write(
          AUDIT_EVENTS.SUBAGENT_PERSIST_FAILED,
          `agentId=${this.agentId}`,
          `error=${e instanceof Error ? e.message : String(e)}`,
        );
      }

      sw.write({ ts: Date.now(), type: 'turn_end' });
      this.auditWriter.write('turn_end');
      turnEnded = true;

      // Extract final text result
      return result.finalText || '[No output produced]';
    } catch (error) {
      // Log error
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.appendToLog(`=== Error: ${errMsg} ===\n`);

      if (error instanceof ToolTimeoutError) {
        sw.write({ ts: Date.now(), type: 'turn_interrupted', message: `Timeout after ${this.timeoutMs}ms` });
        this.auditWriter.write('turn_interrupted', 'reason=system');
      } else {
        sw.write({ ts: Date.now(), type: 'turn_error', error: errMsg });
        this.auditWriter.write('turn_error', `err=${errMsg}`);
      }
      turnEnded = true;

      throw error;
    } finally {
      // 统一清理所有 timer，避免内存泄漏
      clearTimeout(timeoutId);
      clearTimeout(idleTimerId);
      // Safety net: write turn_end only if no specific turn end event was already written
      if (!turnEnded) {
        sw.write({ ts: Date.now(), type: 'turn_end' });
        this.auditWriter.write('turn_end');
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
      this.audit?.write(
        AUDIT_EVENTS.SUBAGENT_LOG_APPEND_FAILED,
        `agentId=${this.agentId}`,
        `error=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
