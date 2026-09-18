/**
 * Agent Executor - Multi-step agent loop with circuit breakers
 *
 * Repeatedly calls StepExecutor (executeStep) until a final result or exception.
 * Maintains cross-step counters (stepCount, parseErrorStrikes,
 * maxTokensToolUseStrikes — strike 语义：自上次成功起累计、另类失败不重置).
 * Calls onAfterStep callback after each
 * successful step for caller to persist (see loop.ts shim + design
 * l3_agent_executor.md §A.invariant-2; SessionStore 落盘 phase409 已迁 caller).
 */

import type { ToolDefinition, ToolUseId } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';

import { executeStep, throwAbortError, type StepCallbacks, type StepMeta, type FinalStopReason } from '../step-executor/index.js';
import { asFinalStopReason } from '../step-executor/index.js';
import { commitTurnEvent, type TurnEventCommitDeps } from './turn-event-commit.js';
import { createStepExecutorEventSink } from '../step-executor/index.js';
import type { AgentExecutorEventSink } from './event-sink.js';
import type { LoopStopRequest } from './loop-stop.js';
import { MaxStepsExceededError, ConsecutiveParseErrorsExceededError, ConsecutiveMaxTokensToolUseError, WallTimeExceededError } from './errors.js';
import { DEFAULT_MAX_STEPS } from './defaults.js';

import { MAX_CONSECUTIVE_PARSE_ERRORS, MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE } from './constants.js';

interface AgentInput {
  messages: Message[];
  systemPrompt: string;
  llm: LLMOrchestrator;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;
  ctx: ExecContext;

  maxSteps?: number;                              // 默认 DEFAULT_MAX_STEPS（1000）
  maxConsecutiveParseErrors?: number;             // 默认 constants.ts MAX_CONSECUTIVE_PARSE_ERRORS (=3)
  maxConsecutiveMaxTokensToolUse?: number;        // 默认 constants.ts MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE (=3)
  maxTokens?: number;                  // 透传给 executeStep
  idleTimeoutMs?: number;              // 透传给 StepInput
  /** per-loop wall-time 预算（自 loop 起始计时；仅每 step 顶部检查——非硬中断，硬限制归 AbortSignal owner） */
  wallTimeBudgetMs?: number;
  stepCallbacks?: StepCallbacks;
  /** Minimal stream sink for AgentExecutor-owned turn event commits. */
  streamCallbacks?: TurnEventCommitDeps;
  /** phase 706: stepCount is maintained internally; caller receives it for persistence/audit. */
  onAfterStep?: (meta: StepMeta, stepCount: number) => void | Promise<void>;
  /**
   * phase 1856 (AE-D9): AgentExecutor-owned 结构化事件 sink（toolCallInput/toolResult/
   * stepCompleted）。身份绑定与审计行格式化归 caller adapter；本循环只发结构化事实。
   */
  eventSink?: AgentExecutorEventSink;
  // phase 1857 Step I (SE-D9): auditWriter/currentContractId 不再透传 executeStep——
  // StepExecutor 单一事件出口（下方 stepEventSink adapter 组合展示+持久化+身份绑定）。
  auditWriter?: AuditLog;
  currentContractId?: string;
  // phase 690: 撤 dialogStore + contextManagerConfig 透传 — proactive trim
  // 已上提到 L5 Runtime 反应式 retry 路径、agent-executor 不再透传。
}

interface AgentResult {
  finalText: string;
  stepsUsed: number;
  stopReason: FinalStopReason;
  /** phase 1856 (AE-D10): typed loop stop request（如 result_capture 早停）。 */
  stopRequest?: LoopStopRequest;
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const {
    messages, systemPrompt, llm, tools, executor, registry, ctx,
    maxTokens,
    stepCallbacks,
    onAfterStep,
    auditWriter,
    currentContractId,
  } = input;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxConsecutiveParseErrors = input.maxConsecutiveParseErrors ?? MAX_CONSECUTIVE_PARSE_ERRORS;
  const maxConsecutiveMaxTokensToolUse = input.maxConsecutiveMaxTokensToolUse ?? MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE;

  let stepCount = 0;
  // phase 1856 (AE-D4) strike 语义契约（取代旧「连续 consecutive」表述）：
  // strike = 自上次成功步以来累计的该类失败步数；另类失败不重置、仅成功步双清。
  // phase 1483 doc（行为保留、表述修正）：两个熔断器计数器独立累积、互不重置。
  // 'continue' 路径在无 parse error 时重置 parseErrorStrikes=0、并无条件重置 maxTokensToolUseStrikes=0；
  // 'max_tokens_tool_use' 路径只递增自身、不动 parseErrorStrikes。
  // 设计后果：parse_err → max_tokens → parse_err 交替序列里 parse strike 不被 max_tokens 步重置（累计语义：交替仍计入 parse strike）；
  //          max_tokens → continue(成功) → max_tokens 序列里 max_tokens strike 被成功 'continue' 重置。
  let parseErrorStrikes = 0;
  let maxTokensToolUseStrikes = 0;

  const startMs = Date.now();
  const wallTimeBudgetMs = input.wallTimeBudgetMs;
  const eventSink = input.eventSink;

  // phase 1856 (AE-D9): TOOL_CALL_INPUT 事件改走结构化 sink（列格式化归 caller adapter）。
  const callbacks: StepCallbacks = {
    ...stepCallbacks,
    onUnparseableToolUse: stepCallbacks?.onUnparseableToolUse ?? (() => {}),
  };
  if (eventSink) {
    const existingOnToolCallInput = stepCallbacks?.onToolCallInput;
    callbacks.onToolCallInput = (toolName: string, toolUseId: ToolUseId, args: Record<string, unknown>) => {
      existingOnToolCallInput?.(toolName, toolUseId, args);
      eventSink.toolCallInput({
        toolName,
        toolUseId,
        step: stepCount,
        argsSize: JSON.stringify(args).length,
      });
    };
  }

  // phase 729: stream dispatch moved from Runtime to AgentExecutor (M#2 own business semantics).
  // phase 1856 (AE-D1): 组合而非覆盖 — caller 经 stepCallbacks 传入的同名 handler 不再被静默丢弃。
  // 顺序：AgentExecutor-owned turn event commit 先行（stream 权威记录，不得被 caller handler 失败吞掉），
  // caller handler 随后；caller handler 抛错按原语义传播（不新增吞没）。
  if (input.streamCallbacks) {
    const turnEventSink = input.streamCallbacks;
    const prevOnTextEnd = callbacks.onTextEnd;
    callbacks.onTextEnd = () => {
      commitTurnEvent({ kind: 'text_end' }, turnEventSink);
      prevOnTextEnd?.();
    };
    const prevOnToolCall = callbacks.onToolCall;
    callbacks.onToolCall = (n, id) => {
      commitTurnEvent({ kind: 'tool_call', name: n, toolUseId: id }, turnEventSink);
      prevOnToolCall?.(n, id);
    };
    const prevOnToolResult = callbacks.onToolResult;
    callbacks.onToolResult = (name, toolUseId, result) => {
      // phase 730: AgentExecutor owns TOOL_RESULT event + stream emit.
      // phase 1856 (AE-D9): 审计写改走结构化 sink（列格式化归 caller adapter）。
      commitTurnEvent(
        { kind: 'tool_result', name, toolUseId, result, step: stepCount, maxSteps },
        turnEventSink,
      );
      eventSink?.toolResult({
        toolName: name,
        toolUseId,
        step: stepCount,
        success: result.success,
        content: result.content ?? '',
      });
      prevOnToolResult?.(name, toolUseId, result);
    };
  }

  while (stepCount < maxSteps) {
    if (wallTimeBudgetMs !== undefined) {
      const elapsed = Date.now() - startMs;
      if (elapsed > wallTimeBudgetMs) {
        throw new WallTimeExceededError(wallTimeBudgetMs, elapsed);
      }
    }
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    // phase 777: result-capture tools (done) request early stop.
    // capturedResult is read by runSubagent regardless of finalText.
    // phase 1856 (AE-D10): typed stop request — 真实停止原因（result capture）入契约，
    // stopReason 不再伪造 'end_turn'（消费方按 stopRequest.kind 识别）。
    if (ctx.stopRequested) {
      return {
        finalText: '',
        stepsUsed: stepCount,
        stopReason: asFinalStopReason('unknown'),
        stopRequest: { kind: 'result_capture' },
      };
    }

    const result = await executeStep({
      messages, systemPrompt, llm, tools, executor, registry, ctx,
      maxTokens,
      idleTimeoutMs: input.idleTimeoutMs,
      callbacks,
      // phase 1857 Step I (SE-D9): StepExecutor 单一事件出口——caller adapter 组合
      // 展示（callbacks）+ 持久化（audit 行）+ contract_id/trace_id 身份绑定。
      eventSink: createStepExecutorEventSink({
        callbacks,
        auditWriter,
        contractId: currentContractId,
        traceId: String(ctx.trace_id ?? ''),
      }),
    });

    if (result.kind === 'final') {
      return {
        finalText: result.finalText || (result.stopReason === 'content_filter' ? '[Content filtered]' : result.finalText),
        stepsUsed: stepCount,
        stopReason: result.stopReason,
      };
    }

    if (result.kind === 'continue') {
      // 1. 步进（落盘归 caller 经 onAfterStep callback / phase409 align M#1+M#3）
      stepCount++;

      // 2. step 完成事件 (phase 730: AgentExecutor owns step completion event)
      // phase 1856 (AE-D3): 完整 step 的提交证据（stepCompleted + onAfterStep）先于熔断终态落定，
      // 熔断抛出时最后一个已修改 messages 的 step 也有持久化 hook / DP「运行中信息不丢弃」。
      // phase 1856 (AE-D9): 结构化 sink；身份绑定与列格式化归 caller adapter。
      eventSink?.stepCompleted({ step: stepCount });

      // 3. onAfterStep（步进之后、熔断检查之前）
      if (onAfterStep) {
        await onAfterStep(result.meta, stepCount);
      }

      // 4. 熔断判定（parse errors）
      if (result.meta.allParseErrors) {
        parseErrorStrikes++;
        // Strike 2: warn agent before termination at strike 3
        if (parseErrorStrikes === maxConsecutiveParseErrors - 1) {
          messages.push({
            role: 'user' as const,
            content: `[system warning] 工具参数 JSON 解析失败已累计 ${parseErrorStrikes} 次（自上次成功起）。下一次将终止当前任务。请检查工具调用中的 JSON 格式是否正确。`,
          });
        }
        if (parseErrorStrikes >= maxConsecutiveParseErrors) {
          // 从最近一条 assistant 消息的 tool_use blocks 提取工具名（为错误消息保留上下文）
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          const lastContent = lastAssistant?.content;
          const toolNamesFromBlocks = Array.isArray(lastContent)
            ? lastContent
                .filter((b): b is { type: 'tool_use'; name: string } => (b as { type?: string }).type === 'tool_use')
                .map(b => b.name)
                .join(', ')
            : '';
          // Stream-layer parse errors may have no tool_use blocks; use meta.toolNames as fallback
          const toolNames = toolNamesFromBlocks || result.meta.toolNames || '';
          throw new ConsecutiveParseErrorsExceededError(maxConsecutiveParseErrors, toolNames);
        }
      } else {
        parseErrorStrikes = 0;
        // phase 454 (review N3-M): max-tokens strike 仅在 parse-success 时重置；
        // parse-error continue 不再重置 max-tokens、保 strike independence
        maxTokensToolUseStrikes = 0;
      }

      continue;
    }

    if (result.kind === 'max_tokens_tool_use') {
      // phase 1856 (AE-D3): 与 'continue' 分支同序 — 步进 → step audit → onAfterStep → 计数与熔断。
      // 熔断终态（ConsecutiveMaxTokensToolUseError）抛出前，该 step 的提交证据已落定。
      stepCount++;

      // phase 730: step completion event in max_tokens_tool_use path too
      // phase 1856 (AE-D9): 结构化 sink（同上）。
      eventSink?.stepCompleted({ step: stepCount });

      // phase 337 M4 (review-2026-06-13): max_tokens_tool_use 分支也调 onAfterStep
      // 与 'continue' 分支对齐。否则该步 session save / contract auditor maybeAuditStep
      // / inbox check 全跳、违 DP「运行中信息不丢弃」。
      if (onAfterStep) {
        await onAfterStep(result.meta, stepCount);
      }

      maxTokensToolUseStrikes++;
      // Strike 2: warn agent before termination at strike 3
      if (maxTokensToolUseStrikes === maxConsecutiveMaxTokensToolUse - 1) {
        messages.push({
          role: 'user' as const,
          content: `[system warning] 因 token 上限截断工具调用已累计 ${maxTokensToolUseStrikes} 次（自上次成功起）。下一次将终止当前任务。请将内容拆分为多次较小的调用。`,
        });
      }
      if (maxTokensToolUseStrikes >= maxConsecutiveMaxTokensToolUse) {
        throw new ConsecutiveMaxTokensToolUseError(maxConsecutiveMaxTokensToolUse);
      }

      continue;
    }

    // TS exhaustiveness
    const _exhaustive: never = result;
    throw new Error(`Unexpected StepResult: ${JSON.stringify(_exhaustive)}`);
  }

  throw new MaxStepsExceededError(maxSteps);
}
