/**
 * SubAgent - Independent ReAct agent for delegated tasks
 * 
 * SubAgent runs with restricted permissions and cannot spawn other agents.
 */

import { runReact, DEFAULT_MAX_STEPS } from '../agent-executor/index.js';
import { formatErr } from '../../foundation/utils/index.js';
import type { ToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ToolDefinition } from '../../foundation/llm-provider/types.js';
import { SUBAGENT_TIMEOUT_MS } from './constants.js';
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
import { createTimeoutController } from './timeout-controller.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { classifyAndAuditError } from './error-classifier.js';



export interface SubAgentOptions {
  agentId: string;
  resultDir: string;        // phase443: caller 注入完整 path（如 `tasks/results/${task.id}`）/ SubAgent 0 知字符串约定
  messageStore: DialogStore;             // phase453: caller 装配期注入 ephemeral DialogStore（filename='messages.json' / 0 clawId / 0 archive 触发）
  prompt: string;
  /** phase 1489 (ML#8 derive): caller 装配期 own ToolExecutor 构造 / SubAgent 不再 own 7 个 executor-only 字段（clawDir/chestnutRoot/syncDir/fsFactory/workspaceDir/subagentMaxSteps/toolTimeoutMs）。 */
  toolExecutor: ToolExecutor;
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  fs: FileSystem;
  // phase 1490: maxSteps optional / undefined → boundary fallback to DEFAULT_MAX_STEPS at ExecContext 构造点
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  toolsForLLM?: ToolDefinition[];  // Pre-filtered tool list for LLM, overrides registry.getAll()
  idleTimeoutMs?: number;
  onIdleTimeout?: () => void;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  systemPrompt?: string;                    // 替换 run() 里硬编码的默认 system prompt
  callerType?: CallerType;  // 默认 'subagent'
  messages?: Message[];                      // 若提供，直接用；否则从 prompt 构建
  originClawId?: string;                     // 创建链路源头，传给子 SubAgent
  isShadow?: boolean;                         // phase 767：shadow 分身标记
  taskStreamWriter: StreamLog;
  auditWriter: AuditLog;          // tasks/queues/results/{id}/audit.tsv，step 11+ 写事件
  permissionChecker?: PermissionChecker;                      // phase 1072: subagent file tool permission check
}

export class SubAgent {
  private agentId: string;
  private resultDir: string;
  private messageStore: DialogStore;
  private prompt: string;
  private toolExecutor: ToolExecutor;
  private llm: LLMOrchestrator;
  private registry: ToolRegistry;
  private fs: FileSystem;
  private maxSteps?: number;
  private maxConsecutiveParseErrors?: number;
  private maxConsecutiveMaxTokensToolUse?: number;
  private timeoutMs: number;
  private signal?: AbortSignal;
  private logPath: string;
  private toolsForLLM?: ToolDefinition[];
  private idleTimeoutMs?: number;
  private onIdleTimeout?: () => void;
  private systemPrompt?: string;
  private callerType?: CallerType;
  private messages?: Message[];
  private originClawId?: string;
  private isShadow?: boolean;
  private taskStreamWriter: StreamLog;
  private auditWriter: AuditLog;
  private permissionChecker?: PermissionChecker;


  constructor(options: SubAgentOptions) {
    this.agentId = options.agentId;
    this.resultDir = options.resultDir;
    this.messageStore = options.messageStore;
    this.prompt = options.prompt;
    this.toolExecutor = options.toolExecutor;
    this.llm = options.llm;
    this.registry = options.registry;
    this.fs = options.fs;
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
    this.callerType = options.callerType;
    this.messages = options.messages;
    this.originClawId = options.originClawId;
    this.isShadow = options.isShadow;
    this.taskStreamWriter = options.taskStreamWriter;
    this.auditWriter = options.auditWriter;
    this.permissionChecker = options.permissionChecker;
  }

  /**
   * Run the subagent and return final text result
   */
  async run(): Promise<string> {
    const startTime = Date.now();

    const timeout = createTimeoutController({
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      onIdleTimeout: this.onIdleTimeout,
      externalSignal: this.signal,
      auditWriter: this.auditWriter,
      agentId: this.agentId,
    });
    timeout.resetIdle?.();

    const stream = createStreamCallbacks({
      streamWriter: this.taskStreamWriter,
      auditWriter: this.auditWriter,
      agentId: this.agentId,
    });

    // Turn start: written before any potentially-throwing init so catch always pairs it
    stream.safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_START });
    this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_START);

    try {
      const callerType = this.callerType ?? 'subagent';
      const executorProfile = callerTypeToProfile(callerType);
      const executor = this.toolExecutor;

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
      // Tool 层超时通过 timeout.signal 传到 ctx.signal；LLM stream
      // (collectStreamResponse) 也消费 ctx.signal，fetch/SDK 会实际取消请求
      // (见 src/foundation/llm-provider/abort-helper.ts)。race 保留为最外层保险：若某
      // provider 未正确响应 signal，timeout 胜出时 timeoutPromise 立即抛 ToolTimeoutError。
      const result = await Promise.race([
        runReact({
          messages,
          systemPrompt,
          llm: this.llm,
          executor,
          ctx: executor.getExecContext(executorProfile, {
            clawId: makeClawId(this.agentId),
            // phase 1490: SubAgent boundary resolve ExecContext.maxSteps（mirror runtime.ts:212 / runtime-boundary owns single resolve point）
            maxSteps: this.maxSteps ?? DEFAULT_MAX_STEPS,
            signal: timeout.signal,
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
          onBeforeLLMCall: stream.callbacks.onBeforeLLMCall,
          onTextDelta: (delta: string) => { timeout.resetIdle?.(); stream.callbacks.onTextDelta(delta); },
          onThinkingDelta: (delta: string) => { timeout.resetIdle?.(); stream.callbacks.onThinkingDelta(delta); },
          onTextEnd: stream.callbacks.onTextEnd,
          onToolCall: async (name, toolUseId) => {
            timeout.resetIdle?.();
            stream.callbacks.onToolCall(name, toolUseId);
            auditStepTools.push(name);
            await this.appendToLog(`Tool called: ${name}\n`);
          },
          onToolCallInput: stream.callbacks.onToolCallInput,
          onToolResult: stream.callbacks.onToolResult,
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
        timeout.timeoutPromise,
      ]);

      // Log completion
      const duration = Date.now() - startTime;
      await this.appendToLog(`=== Completed in ${duration}ms ===\n`);
      await this.appendToLog(`Stop reason: ${result.stopReason}\n`);
      await this.appendToLog(`Final text: ${result.finalText}\n`);

      stream.safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_END });
      this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);
      stream.markTurnEnded();

      // Extract final text result
      return result.finalText ?? '[No output produced]';
    } catch (error) {
      const errMsg = formatErr(error);
      await this.appendToLog(`=== Error: ${errMsg} ===\n`);

      classifyAndAuditError({
        error,
        safeSwWrite: stream.safeSwWrite,
        auditWriter: this.auditWriter,
        timeoutMs: this.timeoutMs,
      });
      stream.markTurnEnded();
      stream.closeSw();

      throw error;
    } finally {
      // 清理 timer + external signal listener（idempotent）
      timeout.cleanup();
      // Safety net: write turn_end only if no specific turn end event was already written
      if (!stream.isTurnEnded()) {
        stream.safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_END });
        this.auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_END);
        stream.closeSw();
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
