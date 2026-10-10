/**
 * SubAgent - Independent ReAct agent for delegated tasks
 * 
 * SubAgent runs with restricted permissions and cannot spawn other agents.
 */

import { runReact, type ReactOptions, type ReactResult, type LoopStopRequest } from '../agent-executor/index.js';
// phase 692 Step B: 删 MOTION_CLAW_ID import (L3 → L4 反向 import = M#5 违反)。
import { formatErr } from '../../foundation/node-utils/index.js';
import type { ToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import {
  ExternalAbortError,
  isAbortError,
  makeExternalAbortError,
  makeToolUseId,
  type ToolDefinition,
  type ToolUseBlock,
  type ToolResultBlock,
  type ToolUseId } from '../../foundation/llm-provider/index.js';
import { SUBAGENT_TIMEOUT_MS } from './constants.js';

import type { Message } from '../../foundation/dialog-store/index.js';
import type { TraceId } from '../../foundation/audit/index.js';
import type { SubAgentLifecycleSink } from './lifecycle-sink.js';
import { SUBAGENT_EVENTS } from './stream-events.js';
import type { StreamLog } from '../../foundation/stream/index.js';

import type { DialogStore } from '../../foundation/dialog-store/index.js';
import { applyBlockIdAssignments } from '../../foundation/dialog-store/index.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../templates/prompts/index.js';
import type { PermissionChecker, ToolProfile } from '../../foundation/tool-protocol/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { SubAgentRecoveryStore, ResumeCursor } from './recovery-state.js';
// Phase 1933 Step G: 不确定副作用 typed 错误（值导入：resume 段 throw 用）
import { RecoveryUncertainSideEffectError, SubAgentRecoveryStoreError } from './recovery-state.js';
import { createTimeoutController } from './timeout-controller.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { classifyAndAuditError } from './error-classifier.js';
import { assertStepsEntryShape } from './invariants.js';
import { auditSubagentArtifactCompleteness } from './artifact-cross-source-audit.js';
import { commitTurnEvent, type TurnEventCommitDeps } from '../agent-executor/index.js';
import { ToolError, type ExecContext } from '../../foundation/tools/index.js';
// Phase 1933 Step D: 续跑段消息合成复用 step-executor 原语（barrel 引入，M#7/M#8）
import {
  appendAssistantMessage,
  appendToolResults,
  toToolResultBlock,
  type CompleteLLMResponse,
  type ToolResultFact,
} from '../step-executor/index.js';



/**
 * phase 1858 Step G (SA-D6): 持久化/结算降级证据单元（哪些 artifact、何阶段失败）。
 * 由 SubAgent 在 best-effort 写点失败时收集；run helper 并入 typed outcome（成功路径）
 * 或随错误对象移交（失败路径）。同 (artifact, stage, error) 重复失败折叠为一项。
 */
export interface DegradedArtifact {
  artifact: 'steps_log' | 'dialog' | 'log' | 'completeness';
  stage: string;
  error: string;
}

export interface SubAgentOptions {
  agentId: string;
  resultDir: string;        // phase443: caller 注入完整 path（如 `tasks/results/${task.id}`）/ SubAgent 0 知字符串约定
  messageStore: DialogStore;             // phase453: caller 装配期注入 ephemeral DialogStore（filename='messages.json' / 0 clawId / 0 archive 触发）
  prompt: string;
  /** phase 1489 (M#8 derive): caller 装配期 own ToolExecutor 构造 / SubAgent 不再 own 7 个 executor-only 字段（clawDir/chestnutRoot/syncDir/fsFactory/workspaceDir/subagentMaxSteps/toolTimeoutMs）。 */
  toolExecutor: ToolExecutor;
  llm: LLMOrchestrator;
  registry: ToolRegistry;
  fs: FileSystem;
  // phase 1490: maxSteps optional / undefined → boundary fallback to DEFAULT_MAX_STEPS in runReact
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  toolsForLLM?: ToolDefinition[];  // Pre-filtered tool list for LLM, overrides registry.getAll()
  idleTimeoutMs?: number;
  onIdleTimeout?: () => void;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  systemPrompt?: string;                    // 替换 run() 里硬编码的默认 system prompt
  toolProfile?: ToolProfile;             // caller 直接声明 capability profile
  messages?: Message[];                      // 若提供，直接用；否则从 prompt 构建
  taskStreamWriter: StreamLog;
  /** phase 1858 Step K (SA-D10): 最小结构化 lifecycle sink（真 AuditLog 由 run helper adapter 适配）。 */
  sink: SubAgentLifecycleSink;
  traceId: TraceId;
  // phase 1858 Step K (SA-D10): currentContractId 归 lifecycle sink adapter 绑定（本层不再持有）
  permissionChecker?: PermissionChecker;                      // phase 1072: subagent file tool permission check
  /** phase 1031: ReAct loop factory DI seam — tests inject mock runReact, production defaults to real loop */
  runReact?: (options: ReactOptions) => Promise<ReactResult>;
  /**
   * Phase 1933 Step D: 可选恢复存储（加载面 + RecoveryDelivery 交付面）。
   * 注入后 run() 开头从最后安全 checkpoint 恢复；缺席时行为与现状逐位一致。
   */
  recoveryStore?: SubAgentRecoveryStore;
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
  /** phase 1858 Step C (SA-D2): 本次 run 实际解析出的工具集快照（finally 落盘与 run 期间同源） */
  private resolvedToolsForLLM?: ToolDefinition[];
  private idleTimeoutMs?: number;
  private onIdleTimeout?: () => void;
  private systemPrompt?: string;
  private toolProfile?: ToolProfile;
  private messages?: Message[];
  private _hasRun = false;
  private taskStreamWriter: StreamLog;
  private sink: SubAgentLifecycleSink;
  private traceId: TraceId;
  private permissionChecker?: PermissionChecker;
  private runReact: (options: ReactOptions) => Promise<ReactResult>;
  private recoveryStore?: SubAgentRecoveryStore;

  // phase 283: textEndCount retained for AC-4; other counters dropped (by-construction equal via commitTurnEvent)
  private textEndCount = 0;

  /** phase 1858 Step G (SA-D6): best-effort 写点降级证据 */
  private degradedArtifacts: DegradedArtifact[] = [];

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
    this.toolProfile = options.toolProfile;
    this.messages = options.messages;
    this.taskStreamWriter = options.taskStreamWriter;
    this.sink = options.sink;
    this.traceId = options.traceId;
    this.permissionChecker = options.permissionChecker;
    this.runReact = options.runReact ?? runReact;
    this.recoveryStore = options.recoveryStore;
  }

  /**
   * Run the subagent and return final text result
   */
  async run(): Promise<string> {
    // phase 464 (review N3-L): re-entry guard — this.messages 在 run() 内
    // 通过 push 累计 mutate、第二次 run() 会复用累积状态导致历史错乱。
    if (this._hasRun) {
      throw new Error(`SubAgent.run() is one-shot for agentId=${this.agentId}`);
    }
    this._hasRun = true;
    const startTime = Date.now();

    const timeout = createTimeoutController({
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      onIdleTimeout: this.onIdleTimeout,
      externalSignal: this.signal,
      sink: this.sink,
    });
    timeout.resetIdle?.();

    const stream = createStreamCallbacks({
      streamWriter: this.taskStreamWriter,
      sink: this.sink,
    });

    // Turn start: written before any potentially-throwing init so catch always pairs it
    stream.safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_START });
    this.sink.turnStart();

    try {
      const executorProfile = this.toolProfile ?? 'subagent';
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
      // phase 1858 Step C (SA-D2): 解析一次实际使用集 — finally 落盘同源（替代 `this.toolsForLLM ?? []` 空覆盖）
      this.resolvedToolsForLLM = tools;

      // Phase 1933 Step D: 通用安全续跑——timeout controller 建立后、runReact 前，
      // 从最后安全 checkpoint 恢复（完整 LLM 响应已提交则不重复请求、已提交工具结果不重复执行）。
      // 无 store / 无 cursor / 损坏回退时本段零行为变化（messages 保持上方全新构建）。
      // 本段在 try 内：resume 段 toolExecutor 的 abort/timeout 走既有 classifyAndAuditError 路径。
      if (this.recoveryStore) {
        // freshBaseline：全新构建基线浅拷贝（message 对象共享、数组结构独立）——
        // resume 中段发现事实不自洽时回退「无 cursor」路径用。
        const freshBaseline = [...messages];
        await this.resumeFromRecoveryCheckpoint(this.recoveryStore, {
          freshBaseline,
          // ctx 与 runReact 相同的 getExecContext 构造（timeout.signal 生效、abort 传播）
          ctx: executor.getExecContext(executorProfile, {
            clawId: this.agentId,
            signal: timeout.signal,
            permissionChecker: this.permissionChecker,
            subagentTaskId: this.agentId,
            trace_id: this.traceId,
          }),
          signal: timeout.signal,
          systemPrompt,
          tools,
        });
      }

      // Run ReAct loop，用 Promise.race 强制超时退出
      // Tool 层超时通过 timeout.signal 传到 ctx.signal；LLM stream
      // (collectStreamResponse) 也消费 ctx.signal，fetch/SDK 会实际取消请求
      // (见 src/foundation/llm-provider/abort-helper.ts)。race 保留为最外层保险：若某
      // provider 未正确响应 signal，timeout 胜出时 timeoutPromise 立即抛 ToolTimeoutError。
      // Phase 283: turn event commit unified entry (subagent reuses runtime helper)
      const emitDeps = adaptSubagentCallbacks(stream.callbacks);

      /** Adapter: subagent PrimitiveStreamCallbacks → TurnEventCommitDeps. */
      function adaptSubagentCallbacks(
        callbacks: {
          onTextEnd: () => void;
          onToolCall: (name: string, toolUseId: ToolUseId) => void;
          onToolResult: (name: string, toolUseId: ToolUseId, result: { success: boolean; content?: string }, step: number, maxSteps: number) => void;
        },
      ): TurnEventCommitDeps {
        return {
          onTextEnd: callbacks.onTextEnd,
          onToolCall: callbacks.onToolCall,
          onToolResult: (name, toolUseId, result, step, maxSteps) => {
            callbacks.onToolResult(name, toolUseId, result, step, maxSteps);
          },
        };
      }

      // phase 337 M6 (review-2026-06-13): 显式持 runReact promise、timeout 赢 race 时
      // await 其结束。否则 runReact 内部 tool/agent loop 在 subagent "returned" 后继续跑、
      // tool 结果写盘形成 orphan write、违 phase 805 sub-3「subagent workspace 0 创建」.
      // signal 已通过 timeout.signal 抛 turn_timeout / idle_timeout、runReact 会感知 abort、
      // 我们等其自然 settle、再抛 race 的 timeout error 出。
      const runReactPromise: Promise<{ finalText?: string; stopReason: string; stopRequest?: LoopStopRequest }> = this.runReact({
        messages,
          systemPrompt,
          llm: this.llm,
          executor,
          ctx: executor.getExecContext(executorProfile, {
            clawId: this.agentId,
            signal: timeout.signal,
            permissionChecker: this.permissionChecker,
            subagentTaskId: this.agentId,
            trace_id: this.traceId,
          }),
          maxSteps: this.maxSteps,
          maxConsecutiveParseErrors: this.maxConsecutiveParseErrors,
          maxConsecutiveMaxTokensToolUse: this.maxConsecutiveMaxTokensToolUse,
          registry: this.registry,  // Enable parallel execution for readonly tools
          tools,                    // Enable native tool_use
          // Phase 1933 Step D: store 实现 RecoveryDelivery，直接透传（缺席 = undefined = 不提交）
          recovery: this.recoveryStore,
          stepCallbacks: {
            onLLMResult: (info) => {
              if (info.error) {
                this.sink.llmError({ model: info.model, error: info.error, latencyMs: info.latencyMs });
              } else {
                this.sink.llmCall({
                  model: info.model,
                  inputTokens: info.inputTokens,
                  outputTokens: info.outputTokens,
                  latencyMs: info.latencyMs,
                });
              }
            },
            onBeforeLLMCall: stream.callbacks.onBeforeLLMCall,
            onTextDelta: (delta: string) => { timeout.resetIdle?.(); stream.callbacks.onTextDelta(delta); },
            onThinkingDelta: (delta: string) => { timeout.resetIdle?.(); stream.callbacks.onThinkingDelta(delta); },
            onTextEnd: () => {
              this.textEndCount++;
              commitTurnEvent({ kind: 'text_end' }, emitDeps);
            },
            onToolCall: async (name, toolUseId) => {
              timeout.resetIdle?.();
              commitTurnEvent({ kind: 'tool_call', name, toolUseId }, emitDeps);
              auditStepTools.push(name);
              await this.appendToLog(`Tool called: ${name}\n`);
            },
            onToolCallInput: stream.callbacks.onToolCallInput,
            onToolUseInput: stream.callbacks.onToolUseInput,  // phase 688: stream.jsonl 落 args body
            onToolUseInputDelta: stream.callbacks.onToolUseInputDelta,  // phase 1180
            onPartialAssistantDiscarded: (info) => {
              // phase 688: catch 路径 partial 丢弃决策 → audit 落「partial_assistant_discarded」
              this.sink.partialAssistantDiscarded({ ...info });
            },
            onToolResult: (name, toolUseId, result, step, maxSteps) => {
              commitTurnEvent({ kind: 'tool_result', name, toolUseId, result, step, maxSteps }, emitDeps);
            },
            onUnparseableToolUse: () => {},
          },
          onStepComplete: async () => {
            try {
              const entryData = {
                step: auditStep,
                ts: new Date().toISOString(),
                tools: auditStepTools,
                elapsedMs: Date.now() - auditStepStart,
              };
              assertStepsEntryShape(entryData, this.sink);
              const entry = JSON.stringify(entryData);
              await this.fs.append(stepsLogPath, entry + '\n');
            } catch (err) {
              this.recordDegraded('steps_log', 'step_complete', err);
              this.sink.stepCompleteFailed({ error: formatErr(err) });
              // 不 throw — audit 失败不终止任务
            }
            // 每步后持久化 messages — 崩溃可恢复、执行中可观察
            let stepSaved = false;
            try {
              const saved = await this.messageStore
                .save({
                  systemPrompt,
                  messages,
                  toolsForLLM: tools,
                });
              // phase 1850 Step C: save 不再隐式写 caller 数组——显式回传 blockId
              applyBlockIdAssignments(messages, saved.assignedBlockIds);
              stepSaved = true;
            } catch (err) {
              this.recordDegraded('dialog', 'step_save', err);
              this.sink.persistFailed({ error: formatErr(err) });
              // 不 throw — 持久化失败不终止任务
            }
            // Phase 1933 Step G: next-llm 严格前置 —— 仅 save 成功才推进游标；
            // save 失败 → cursor 保持 awaiting-conversation-commit（不提前发布）
            if (stepSaved) await this.commitRecoveryConversationBestEffort('step_save');
            auditStep++;
            auditStepTools = [];
            auditStepStart = Date.now();
          },
        });
      let result;
      try {
        result = await Promise.race([runReactPromise, timeout.timeoutPromise]);
      } catch (raceErr) {
        // phase 337 M6: timeout / abort 赢了 race。有界等待 runReact 自然 settle
        // （signal 已 abort、合作的 runReact 会立即抛出）、让 in-flight tool / disk
        // write 收尾。上限 RUNREACT_ABORT_SETTLE_MS 防非合作 runReact 无限阻塞
        // subagent shutdown。
        // phase 1858 Step E (SA-D4): 超窗未收敛不再静默「交给 ghost 兜底」——
        // 留证 + 以 typed 字段随错误移交 owner（可证明分类：已收敛 / 仍运行）。
        const RUNREACT_ABORT_SETTLE_MS = 100;
        const settled = await Promise.race([
          runReactPromise.then(() => true, () => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RUNREACT_ABORT_SETTLE_MS)),
        ]);
        if (!settled) {
          this.sink.runReactAbortStillRunning({ settleMs: RUNREACT_ABORT_SETTLE_MS });
        }
        const carrier = typeof raceErr === 'object' && raceErr !== null
          ? raceErr
          : new Error(formatErr(raceErr));
        throw Object.assign(carrier, { subagentStillRunning: !settled });
      }

      // Log completion
      const duration = Date.now() - startTime;
      await this.appendToLog(`=== Completed in ${duration}ms ===\n`);
      // phase 1856 (AE-D10): capture 停止按 typed stopRequest 识别（替代空文本 + 伪造 'end_turn' 隐式依赖）
      const stopLabel = result.stopRequest?.kind === 'result_capture' ? 'result_capture' : result.stopReason;
      await this.appendToLog(`Stop reason: ${stopLabel}\n`);
      await this.appendToLog(`Final text: ${result.finalText}\n`);

      stream.safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_END });
      this.sink.turnEnd();
      stream.markTurnEnded();

      // Extract final text result
      return result.finalText ?? '[No output produced]';
    } catch (error) {
      // Provider adapters may surface a native DOMException/API AbortError when
      // our owned timeout signal wins. Normalize that boundary representation
      // before domain classification; the classifier itself only accepts the
      // typed external-abort protocol.
      const classifiedError = timeout.signal.aborted
        && isAbortError(error)
        && !(error instanceof ExternalAbortError)
        ? makeExternalAbortError(timeout.signal.reason)
        : error;
      const errMsg = formatErr(classifiedError);
      await this.appendToLog(`=== Error: ${errMsg} ===\n`);

      classifyAndAuditError({
        error: classifiedError,
        safeSwWrite: stream.safeSwWrite,
        sink: this.sink,
        timeoutMs: this.timeoutMs,
      });
      stream.markTurnEnded();
      stream.closeSw();

      throw classifiedError;
    } finally {
      // 清理 timer + external signal listener（idempotent）
      timeout.cleanup();
      // Safety net: write turn_end only if no specific turn end event was already written
      if (!stream.isTurnEnded()) {
        stream.safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_END });
        this.sink.turnEnd();
        stream.closeSw();
      }
      // 持久化 messages — finally 保证超时/中断/正常结束都落盘（best-effort）
      let finalSaved = false;
      try {
        const finalMessages = this.messages ?? [];
        const saved = await this.messageStore
          .save({
            systemPrompt: this.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT,
            messages: finalMessages,
            toolsForLLM: this.resolvedToolsForLLM ?? this.toolsForLLM ?? [],
          });
        // phase 1850 Step C: save 不再隐式写 caller 数组——显式回传 blockId
        applyBlockIdAssignments(finalMessages, saved.assignedBlockIds);
        finalSaved = true;
      } catch (e) {
        this.recordDegraded('dialog', 'final_save', e);
        this.sink.persistFailed({ error: formatErr(e) });
      }
      // Phase 1933 Step G: finally save 成功同样允许推进游标（onStepComplete 不覆盖
      // 最终 step —— end_turn/终态不触发步进回调）；save 失败 → 不推进。
      if (finalSaved) await this.commitRecoveryConversationBestEffort('final_save');

      // phase 270 Step B: multi-artifact completeness cross-source
      // phase 1858 Step D (SA-D3): 纳入结算（await）——rejection 不再被空 catch 静默吞掉；
      // 失败留证后 finally 继续（不 throw，结算失败不改变执行结果）。
      try {
        await auditSubagentArtifactCompleteness(
          {
            resultDir: this.resultDir,
            textEndCount: this.textEndCount,
          },
          { fs: this.fs, messageStore: this.messageStore },
          this.sink,
        );
      } catch (err) {
        this.recordDegraded('completeness', 'artifact_completeness', err);
        this.sink.persistFailed({ stage: 'artifact_completeness', error: formatErr(err) });
      }
    }
  }

  /**
   * Phase 1933 Step D: 安全续跑入口。无 cursor → 零行为变化；cursor 损坏 →
   * sink 留证（recoveryFallback）后按无 cursor 继续；否则按 kind 分发。
   * 保持 _hasRun 一次性语义——resume 发生在单次 run 内。
   */
  private async resumeFromRecoveryCheckpoint(
    store: SubAgentRecoveryStore,
    opts: {
      freshBaseline: Message[];
      ctx: ExecContext;
      signal: AbortSignal;
      systemPrompt: string;
      tools: ToolDefinition[];
    },
  ): Promise<void> {
    const loaded = await store.loadCursor();
    if (loaded.fallbackReason) {
      this.sink.recoveryFallback({ reason: loaded.fallbackReason });
    }
    const cursor = loaded.cursor;
    if (!cursor) return;
    if (cursor.kind === 'next-llm') {
      await this.resumeAtNextLlm(store, opts);
    } else if (cursor.kind === 'awaiting-conversation-commit') {
      await this.resumeAwaitingConversationCommit(store, cursor, opts);
    } else {
      await this.resumeAwaitingTools(store, cursor, opts);
    }
  }

  /**
   * next-llm 续跑：上一回合事实已全部提交，从持久化 messages 恢复对话后直接进 runReact
   * （下一步是新 LLM 调用）。source 'empty' / 空 session → 保持现状全新构建。
   */
  private async resumeAtNextLlm(
    store: SubAgentRecoveryStore,
    opts: { freshBaseline: Message[]; systemPrompt: string; tools: ToolDefinition[] },
  ): Promise<void> {
    const persisted = await this.messageStore.load();
    if (persisted.source === 'empty') return;
    if (persisted.source === 'io_error' || !persisted.session) {
      // 不猜：持久边界不可读 → 回退全新构建（留证）
      this.sink.recoveryFallback({
        reason: `dialog_load_failed: ${persisted.source === 'io_error' ? persisted.error : 'no_session'}`,
      });
      return;
    }
    const restored = persisted.session.messages;
    if (restored.length === 0) return;
    // 就地替换（保持 this.messages 数组引用——runReact/onStepComplete 共享同一引用）
    const messages = this.messages!;
    messages.length = 0;
    messages.push(...restored);
    await this.repairDanglingToolUseTail(store, opts);
  }

  /**
   * dangling 修补：崩溃窗口（最后工具结果已提交、appendToolResults+save 未发生）会在
   * 持久化 messages 末尾留下无配对 tool_result 的 assistant tool_use——runReact 不修复
   * dangling（API 拒），resume 必须先补齐。已提交结果全部在场 → 复原补齐（确定事实、
   * 不重复执行）；任一缺失/不可读 → 不猜，回退全新构建并留证。
   */
  private async repairDanglingToolUseTail(
    store: SubAgentRecoveryStore,
    opts: { freshBaseline: Message[]; systemPrompt: string; tools: ToolDefinition[] },
  ): Promise<void> {
    const messages = this.messages!;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
    const toolUseIds = last.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => String(b.id));
    if (toolUseIds.length === 0) return;
    // 末尾即 assistant = 配对 user tool_result 消息必缺（配对消息必紧随其后）
    let committed: Map<string, ToolResultFact>;
    try {
      committed = await store.loadCommittedToolResults();
    } catch (err) {
      this.sink.recoveryFallback({ reason: `committed_tool_results_unreadable: ${formatErr(err)}` });
      this.resetMessagesToBaseline(opts.freshBaseline);
      return;
    }
    const blocks: ToolResultBlock[] = [];
    for (const id of toolUseIds) {
      const fact = committed.get(id);
      if (!fact) {
        this.sink.recoveryFallback({ reason: `dangling_tool_use_without_committed_result: ${id}` });
        this.resetMessagesToBaseline(opts.freshBaseline);
        return;
      }
      blocks.push(toToolResultBlock(makeToolUseId(id), fact.result));
    }
    appendToolResults(messages, blocks);
    await this.persistMessagesBestEffort(opts.systemPrompt, opts.tools, 'resume_repair_save');
    await this.appendToLog(`Recovery: repaired dangling tool_use tail with ${toolUseIds.length} committed result(s)\n`);
  }

  /**
   * awaiting-tools 续跑：完整 LLM 响应已提交 → 不重复请求 LLM；已提交工具结果直接复原
   * （不重复执行）；pending 工具按响应中 tool_use 原始顺序逐个执行并推进 cursor。
   */
  private async resumeAwaitingTools(
    store: SubAgentRecoveryStore,
    cursor: Extract<ResumeCursor, { kind: 'awaiting-tools' }>,
    opts: {
      freshBaseline: Message[];
      ctx: ExecContext;
      signal: AbortSignal;
      systemPrompt: string;
      tools: ToolDefinition[];
    },
  ): Promise<void> {
    // a. 已提交完整响应是续跑锚点；不可读/损坏 → 留证 + 按无 cursor 继续（此时尚未 mutate messages）
    let committed: CompleteLLMResponse;
    try {
      committed = await store.loadCommittedResponse(cursor.responseId);
    } catch (err) {
      this.sink.recoveryFallback({ reason: `committed_response_unreadable: ${formatErr(err)}` });
      return;
    }
    const response = committed.response;
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const prebuiltResults = response.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
    const prebuiltIds = new Set(prebuiltResults.map((b) => String(b.tool_use_id)));
    const responseToolUseIds = toolUses.map((t) => String(t.id));

    // b. 持久 messages 基底。source 'empty'/空 session → 保留全新构建序列（assistant 追加其上）；
    //    io_error → 持久边界不可读、不猜 → 留证回退（此时尚未 mutate messages）
    const persisted = await this.messageStore.load();
    if (persisted.source === 'io_error' || !persisted.session) {
      this.sink.recoveryFallback({
        reason: `dialog_load_failed: ${persisted.source === 'io_error' ? persisted.error : 'no_session'}`,
      });
      return;
    }
    const messages = this.messages!;
    if (persisted.session.messages.length > 0) {
      messages.length = 0;
      messages.push(...persisted.session.messages);
    }

    // 幂等判重 ①：崩溃发生在重建+落盘之后——末尾已是本响应的完整回合
    // （assistant tool_use + 配对 tool_result user 消息）→ 无需重建，直接进 runReact。
    if (this.isTurnAlreadyPersisted(messages, responseToolUseIds)) return;

    // 判重 ②：末尾 assistant content 与已提交响应的 tool_use id 集合一致 → 不重复 append
    // （崩溃时 finally 兜底已把本响应的 assistant 消息落盘）；否则 append assistant。
    if (!this.isAssistantAlreadyAppended(messages, responseToolUseIds)) {
      // 对齐 handleToolUseStop：assistant 消息剥掉响应内 prebuilt tool_result 块
      appendAssistantMessage(messages, response.content.filter((b) => b.type !== 'tool_result'));
    }

    // c. 已提交结果复原 + pending 执行。先加载全部已提交结果；不可读时——
    //    若存在「不可证明未开始」的 pending 工具（已 started 无结果 / 旧 cursor 缺
    //    started 证据）→ 外部副作用不确定：留证 + 停 uncertain（不删文件、不全新重启）；
    //    全部 pending 可证明未开始（started=[]）→ 无副作用风险，回退全新构建。
    let committedResults: Map<string, ToolResultFact>;
    try {
      committedResults = await store.loadCommittedToolResults();
    } catch (err) {
      const unprovable = this.firstUnprovablePendingId(cursor);
      if (unprovable) {
        this.sink.recoveryFallback({ reason: `uncertain_side_effect_results_unreadable: ${unprovable}` });
        throw new RecoveryUncertainSideEffectError(unprovable, `committed tool results unreadable: ${formatErr(err)}`);
      }
      this.sink.recoveryFallback({ reason: `committed_tool_results_unreadable: ${formatErr(err)}` });
      this.resetMessagesToBaseline(opts.freshBaseline);
      return;
    }
    // 一致性预检（执行任何工具前）：响应/pending/已提交三方必须对得上，对不上即
    // checkpoint 自相矛盾 → 不猜，回退全新构建。
    const pendingSet = new Set(cursor.pendingToolIds);
    const executableIds = responseToolUseIds.filter((id) => !prebuiltIds.has(id));
    const inconsistent = executableIds.some((id) => !committedResults.has(id) && !pendingSet.has(id))
      || cursor.pendingToolIds.some((id) => !executableIds.includes(id));
    if (inconsistent) {
      this.sink.recoveryFallback({ reason: 'cursor_response_fact_mismatch' });
      this.resetMessagesToBaseline(opts.freshBaseline);
      return;
    }

    // 合成 user 消息（对齐 handleToolUseStop 顺序：prebuilt 在前，其余按响应原始顺序）
    const resultBlocks: ToolResultBlock[] = [...prebuiltResults];
    let executedCount = 0;
    let restoredCount = 0;
    for (const tu of toolUses) {
      const id = String(tu.id);
      if (prebuiltIds.has(id)) continue;
      const fact = committedResults.get(id);
      if (fact) {
        // 已提交工具结果：不重复执行，直接复原 ToolResultBlock
        resultBlocks.push(toToolResultBlock(makeToolUseId(id), fact.result));
        restoredCount++;
        continue;
      }
      // pending 工具：abort 优先传播（不误分类为业务/LLM 失败）
      if (opts.signal.aborted) throw makeExternalAbortError(opts.signal.reason);
      // Phase 1933 Step G: 已 started 无 committed result（或旧 cursor 缺 started 证据、
      // 不可证明未开始）→ 外部副作用不确定：不执行该工具，停 uncertain 交上层处置
      // （不自动重试、不当成功/失败/未开始；进入既有 catch 分类/audit 路径）。
      const provablyNotStarted = cursor.startedToolIds !== undefined && !cursor.startedToolIds.includes(id);
      if (!provablyNotStarted) {
        this.sink.recoveryFallback({ reason: `uncertain_side_effect_started_without_result: ${id}` });
        throw new RecoveryUncertainSideEffectError(id);
      }
      await store.toolStarted({
        toolUseId: makeToolUseId(id),
        toolName: tu.name,
        input: tu.input,
        startedAtMs: Date.now(),
      });
      let result: ToolResult;
      try {
        result = await this.toolExecutor.execute({
          toolName: tu.name,
          args: tu.input,
          ctx: opts.ctx,
          toolUseId: makeToolUseId(id),
        });
      } catch (err) {
        // 与 executeSingleTool 同收敛面：仅 ToolError 业务化为失败结果；
        // abort / 系统错误原样传播（走既有 classifyAndAuditError 路径）
        if (!(err instanceof ToolError)) throw err;
        result = { success: false, content: `[${err.name}] 工具执行失败: ${formatErr(err)}` };
      }
      // 每个结果执行后即刻提交（保持 cursor 推进；失败 throw 中止 resume、入既有分类）
      await store.toolResultCommitted({
        toolUseId: makeToolUseId(id),
        toolName: tu.name,
        result,
        resultAtMs: Date.now(),
      });
      resultBlocks.push(toToolResultBlock(makeToolUseId(id), result));
      executedCount++;
    }

    // d. 全部就绪 → appendToolResults → 落盘（best-effort，与既有 save 点同策略）→ 正常 runReact
    if (resultBlocks.length > 0) {
      appendToolResults(messages, resultBlocks);
    }
    // Phase 1933 Step G: 对话 save 成功才允许推进 next-llm（此时 cursor 已随最后一次
    // toolResultCommitted 转 awaiting-conversation-commit）；save 失败（留证不 throw
    // 的既有语义保持）→ 不推进，cursor 停留 awaiting-conversation-commit 供重启重建。
    const resumeSaved = await this.persistMessagesBestEffort(opts.systemPrompt, opts.tools, 'resume_save');
    if (resumeSaved) await this.commitRecoveryConversationBestEffort('resume_save');
    await this.appendToLog(
      `Recovery: resumed awaiting-tools response=${cursor.responseId} restored=${restoredCount} executed=${executedCount}\n`,
    );
  }

  /**
   * Phase 1933 Step G: awaiting-conversation-commit 续跑 —— 完整响应 + 全部工具结果
   * 已提交、仅对话消息未证明持久化。**不请求 LLM、不执行任何工具**：仅凭已提交事实
   * 重建 assistant + tool_result 消息 → messageStore.save → store.commitConversation()
   * → 进 runReact。任一事实缺失/损坏 → 停在 uncertain：sink/audit 留证 + typed error
   * 传播（不删 recovery 文件绕过不一致、不静默全新重启——已提交工具可能有外部副作用）。
   */
  private async resumeAwaitingConversationCommit(
    store: SubAgentRecoveryStore,
    cursor: Extract<ResumeCursor, { kind: 'awaiting-conversation-commit' }>,
    opts: { freshBaseline: Message[]; systemPrompt: string; tools: ToolDefinition[] },
  ): Promise<void> {
    // a. 已提交完整响应是重建锚点；不可读/损坏 → 不猜不绕过：留证 + typed error 传播
    let committed: CompleteLLMResponse;
    try {
      committed = await store.loadCommittedResponse(cursor.responseId);
    } catch (err) {
      this.sink.recoveryFallback({ reason: `committed_response_unreadable: ${formatErr(err)}` });
      throw err;
    }
    const response = committed.response;
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const prebuiltResults = response.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
    const prebuiltIds = new Set(prebuiltResults.map((b) => String(b.tool_use_id)));
    const responseToolUseIds = toolUses.map((t) => String(t.id));

    // b. cursor.toolResultIds 全部在场且与响应可执行集一致；缺失/不可读/不一致 → 停在 uncertain
    let committedResults: Map<string, ToolResultFact>;
    try {
      committedResults = await store.loadCommittedToolResults();
    } catch (err) {
      this.sink.recoveryFallback({ reason: `committed_tool_results_unreadable: ${formatErr(err)}` });
      throw err;
    }
    const executableIds = responseToolUseIds.filter((id) => !prebuiltIds.has(id));
    const resultIdSet = new Set(cursor.toolResultIds);
    const inconsistent = cursor.toolResultIds.some((id) => !committedResults.has(id))
      || executableIds.some((id) => !resultIdSet.has(id))
      || cursor.toolResultIds.some((id) => !executableIds.includes(id));
    if (inconsistent) {
      this.sink.recoveryFallback({ reason: `conversation_commit_fact_mismatch: ${cursor.responseId}` });
      throw new SubAgentRecoveryStoreError(
        'invalid_state',
        `awaiting-conversation-commit facts inconsistent (response=${cursor.responseId})`,
      );
    }

    // c. 持久 messages 基底。empty → 在全新构建序列上重建；io_error/无 session →
    //    持久边界不可读、不猜 → 留证 + throw（不静默全新重启）
    const persisted = await this.messageStore.load();
    if (persisted.source === 'io_error' || !persisted.session) {
      this.sink.recoveryFallback({
        reason: `dialog_load_failed: ${persisted.source === 'io_error' ? persisted.error : 'no_session'}`,
      });
      throw new SubAgentRecoveryStoreError(
        'io',
        `dialog unreadable during awaiting-conversation-commit resume: ${persisted.source === 'io_error' ? persisted.error : 'no_session'}`,
      );
    }
    const messages = this.messages!;
    if (persisted.session.messages.length > 0) {
      messages.length = 0;
      messages.push(...persisted.session.messages);
    }

    // d. 两级幂等判重（与 awaiting-tools 同规则）：崩溃在重建+落盘之后 → 无需重建
    if (!this.isTurnAlreadyPersisted(messages, responseToolUseIds)) {
      if (!this.isAssistantAlreadyAppended(messages, responseToolUseIds)) {
        appendAssistantMessage(messages, response.content.filter((b) => b.type !== 'tool_result'));
      }
      // 按原序合成 tool_result user 消息（对齐 handleToolUseStop：prebuilt 在前，其余按响应原始顺序）
      const resultBlocks: ToolResultBlock[] = [...prebuiltResults];
      for (const tu of toolUses) {
        const id = String(tu.id);
        if (prebuiltIds.has(id)) continue;
        const fact = committedResults.get(id)!; // b 已证明全部在场
        resultBlocks.push(toToolResultBlock(makeToolUseId(id), fact.result));
      }
      if (resultBlocks.length > 0) {
        appendToolResults(messages, resultBlocks);
      }
    }

    // e. 对话落盘成功才允许推进 next-llm；save 失败（留证不 throw）→ 不推进、
    //    继续 runReact（内存对话完整；cursor 停留 awaiting-conversation-commit 供重启重建）
    const saved = await this.persistMessagesBestEffort(opts.systemPrompt, opts.tools, 'resume_conversation_commit_save');
    if (saved) await this.commitRecoveryConversationBestEffort('resume_conversation_commit');
    await this.appendToLog(`Recovery: rebuilt conversation from committed facts response=${cursor.responseId}\n`);
  }

  /** 幂等判重 ①：持久化末尾是否已是本响应的完整回合（assistant tool_use + 配对 tool_result）。 */
  private isTurnAlreadyPersisted(messages: Message[], responseToolUseIds: string[]): boolean {
    if (responseToolUseIds.length === 0) return false;
    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];
    if (!last || !prev || last.role !== 'user' || prev.role !== 'assistant') return false;
    if (!Array.isArray(last.content) || !Array.isArray(prev.content)) return false;
    const resultIds = new Set(
      last.content
        .filter((b): b is ToolResultBlock => b.type === 'tool_result')
        .map((b) => String(b.tool_use_id)),
    );
    const prevIds = prev.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => String(b.id));
    return prevIds.length === responseToolUseIds.length
      && responseToolUseIds.every((id) => prevIds.includes(id))
      && responseToolUseIds.every((id) => resultIds.has(id));
  }

  /**
   * 幂等判重 ②：末尾 assistant content 与已提交响应的 tool_use id 集合一致 → 不重复
   * append（崩溃时 finally 兜底已把本响应的 assistant 消息落盘）。末尾非 assistant
   * 消息 → false（空 tool_use 集也不得误判为「已 append」）。
   */
  private isAssistantAlreadyAppended(messages: Message[], responseToolUseIds: string[]): boolean {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return false;
    const lastAssistantIds = last.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => String(b.id));
    return lastAssistantIds.length === responseToolUseIds.length
      && new Set(lastAssistantIds).size === responseToolUseIds.length
      && responseToolUseIds.every((id) => lastAssistantIds.includes(id));
  }

  /**
   * Phase 1933 Step G: 首个「不可证明未开始」的 pending id。
   * startedToolIds 缺席（旧版 cursor）→ 任何 pending 都不可证明未开始；
   * 在场 → 仅 started ∩ pending 不可证明（started 空数组 = 可证明全部未开始）。
   */
  private firstUnprovablePendingId(
    cursor: Extract<ResumeCursor, { kind: 'awaiting-tools' }>,
  ): string | undefined {
    if (!cursor.startedToolIds) return cursor.pendingToolIds[0];
    const started = new Set(cursor.startedToolIds);
    return cursor.pendingToolIds.find((id) => started.has(id));
  }

  /** 回退「无 cursor」路径：就地重置为全新构建基线（保持数组引用）。 */
  private resetMessagesToBaseline(baseline: Message[]): void {
    const messages = this.messages!;
    messages.length = 0;
    messages.push(...baseline);
  }

  /**
   * resume 段落盘：与 onStepComplete 的 save 同策略（best-effort、失败留证不终止）。
   * 返回是否落盘成功 —— Phase 1933 Step G: 仅成功才允许 commitConversation 推进 next-llm。
   */
  private async persistMessagesBestEffort(
    systemPrompt: string,
    tools: ToolDefinition[],
    stage: string,
  ): Promise<boolean> {
    const messages = this.messages ?? [];
    try {
      const saved = await this.messageStore
        .save({
          systemPrompt,
          messages,
          toolsForLLM: tools,
        });
      applyBlockIdAssignments(messages, saved.assignedBlockIds);
      return true;
    } catch (err) {
      this.recordDegraded('dialog', stage, err);
      this.sink.persistFailed({ error: formatErr(err) });
      return false;
    }
  }

  /**
   * Phase 1933 Step G: 对话 save 成功后的游标推进（best-effort）。
   * commitConversation 仅当 cursor 为 awaiting-conversation-commit 时发布 next-llm
   * （其余状态 no-op 幂等）；原子写失败留证不 throw —— cursor 停留
   * awaiting-conversation-commit，重启后 resume 仅凭已提交事实重建（安全方向）。
   */
  private async commitRecoveryConversationBestEffort(stage: string): Promise<void> {
    if (!this.recoveryStore) return;
    try {
      await this.recoveryStore.commitConversation();
    } catch (err) {
      this.sink.persistFailed({ stage: `commit_conversation:${stage}`, error: formatErr(err) });
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
      // phase 715: 加 path col、与 phase 580/586/684-688/709-711 path forensic 形态对齐
      this.recordDegraded('log', 'append_log', e);
      this.sink.logAppendFailed({ path: this.logPath, error: formatErr(e) });
    }
  }

  /**
   * phase 1858 Step G (SA-D6): 收集降级证据（同 artifact+stage+error 重复失败折叠为一项）。
   */
  private recordDegraded(artifact: DegradedArtifact['artifact'], stage: string, err: unknown): void {
    const error = formatErr(err);
    const exists = this.degradedArtifacts.some(
      (d) => d.artifact === artifact && d.stage === stage && d.error === error,
    );
    if (!exists) this.degradedArtifacts.push({ artifact, stage, error });
  }

  /** phase 1858 Step G (SA-D6): 本次 run 的降级证据（run 结束/失败后由 run helper 读取）。 */
  getDegradedArtifacts(): readonly DegradedArtifact[] {
    return this.degradedArtifacts;
  }
}
