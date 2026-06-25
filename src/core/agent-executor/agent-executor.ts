/**
 * Agent Executor - Multi-step agent loop with circuit breakers
 *
 * Repeatedly calls StepExecutor (executeStep) until a final result or exception.
 * Maintains cross-step counters (stepCount, consecutiveParseErrors,
 * consecutiveMaxTokensToolUse). Calls onAfterStep callback after each
 * successful step for caller to persist (see loop.ts shim + design
 * l3_agent_executor.md §A.invariant-2; SessionStore 落盘 phase409 已迁 caller).
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import { executeStep, throwAbortError, type StepCallbacks, type StepMeta, type FinalStopReason } from '../step-executor/index.js';
import { asFinalStopReason } from '../step-executor/types.js';
import { commitTurnEvent, type TurnEventCommitDeps } from './turn-event-commit.js';
import type { StreamCallbacks } from '../stream-callbacks.js';
import { MaxStepsExceededError, ConsecutiveParseErrorsExceededError, ConsecutiveMaxTokensToolUseError, WallTimeExceededError } from './errors.js';
import { DEFAULT_MAX_STEPS } from './defaults.js';

import { MAX_CONSECUTIVE_PARSE_ERRORS, MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE } from './constants.js';
import { AGENT_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';

export interface AgentInput {
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
  wallTimeDeadlineMs?: number;         // 总 wall-time 上限（可选）
  stepCallbacks?: StepCallbacks;
  /** Stream callbacks from Daemon for turn event emission (L6→L3 via Runtime). */
  streamCallbacks?: StreamCallbacks;
  /** phase 706: stepCount is maintained internally; caller receives it for persistence/audit. */
  onAfterStep?: (meta: StepMeta, stepCount: number) => void | Promise<void>;
  // phase 706: audit writer + per-turn contract id for tool_call_input emit.
  auditWriter?: AuditLog;
  currentContractId?: string;
  // phase 690: 撤 dialogStore + contextManagerConfig 透传 — proactive trim
  // 已上提到 L5 Runtime 反应式 retry 路径、agent-executor 不再透传。
}

export interface AgentResult {
  finalText: string;
  stepsUsed: number;
  stopReason: FinalStopReason;
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
  let consecutiveParseErrors = 0;
  // phase 1483 doc: 两个熔断器计数器独立累积、互不重置。
  // 'continue' 路径在无 parse error 时重置 consecutiveParseErrors=0、并无条件重置 consecutiveMaxTokensToolUse=0；
  // 'max_tokens_tool_use' 路径只递增自身、不动 consecutiveParseErrors。
  // 设计后果：parse_err → max_tokens → parse_err 交替序列里 parse counter 不被 max_tokens 步重置（合规：交替仍计入连续 parse 失败）；
  //          max_tokens → continue(成功) → max_tokens 序列里 max_tokens counter 被成功 'continue' 重置。
  let consecutiveMaxTokensToolUse = 0;

  const startMs = Date.now();
  const deadline = input.wallTimeDeadlineMs;

  // phase 706: AgentExecutor owns TOOL_CALL_INPUT audit (per-step owner).
  const callbacks: StepCallbacks = {
    ...stepCallbacks,
    onUnparseableToolUse: stepCallbacks?.onUnparseableToolUse ?? (() => {}),
  };
  if (auditWriter) {
    const existingOnToolCallInput = stepCallbacks?.onToolCallInput;
    callbacks.onToolCallInput = (toolName: string, toolUseId: ToolUseId, args: Record<string, unknown>) => {
      existingOnToolCallInput?.(toolName, toolUseId, args);
      const argsSize = JSON.stringify(args).length;
      auditWriter.write(
        AGENT_EXECUTOR_AUDIT_EVENTS.TOOL_CALL_INPUT,
        toolName,
        `tool_use_id=${String(toolUseId)}`,
        `step=${stepCount}`,
        `contract_id=${currentContractId ?? ''}`,
        `trace_id=${String(ctx.trace_id ?? '')}`,
        `args_size=${argsSize}`,
      );
    };
  }

  // phase 729: stream dispatch moved from Runtime to AgentExecutor (M#2 own business semantics).
  if (input.streamCallbacks) {
    const streamDeps: TurnEventCommitDeps = {
      onTextEnd: input.streamCallbacks.onTextEnd,
      onToolCall: input.streamCallbacks.onToolCall,
      onToolResult: input.streamCallbacks.onToolResult,
    };
    const origOnToolResult = callbacks.onToolResult;
    callbacks.onTextEnd = () => {
      commitTurnEvent({ kind: 'text_end' }, streamDeps);
    };
    callbacks.onToolCall = (n, id) => {
      commitTurnEvent({ kind: 'tool_call', name: n, toolUseId: id }, streamDeps);
    };
    callbacks.onToolResult = (name, toolUseId, result) => {
      // Runtime still owns TOOL_RESULT audit write; AgentExecutor owns stream emit.
      origOnToolResult?.(name, toolUseId, result);
      commitTurnEvent(
        { kind: 'tool_result', name, toolUseId, result, step: stepCount, maxSteps },
        streamDeps,
      );
    };
  }

  while (stepCount < maxSteps) {
    if (deadline !== undefined) {
      const elapsed = Date.now() - startMs;
      if (elapsed > deadline) {
        throw new WallTimeExceededError(deadline, elapsed);
      }
    }
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    // phase 777: result-capture tools (done) request early stop.
    // capturedResult is read by runSubagent regardless of finalText.
    if (ctx.stopRequested) {
      return { finalText: '', stepsUsed: stepCount, stopReason: asFinalStopReason('end_turn') };
    }

    const result = await executeStep({
      messages, systemPrompt, llm, tools, executor, registry, ctx,
      maxTokens,
      idleTimeoutMs: input.idleTimeoutMs,
      callbacks,
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

      // 2. 熔断判定（parse errors）
      if (result.meta.allParseErrors) {
        consecutiveParseErrors++;
        // Strike 2: warn agent before termination at strike 3
        if (consecutiveParseErrors === maxConsecutiveParseErrors - 1) {
          messages.push({
            role: 'user' as const,
            content: `[system warning] 连续 ${consecutiveParseErrors} 次工具参数 JSON 解析失败。下一次将终止当前任务。请检查工具调用中的 JSON 格式是否正确。`,
          });
        }
        if (consecutiveParseErrors >= maxConsecutiveParseErrors) {
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
        consecutiveParseErrors = 0;
        // phase 454 (review N3-M): max-tokens 计数仅在 parse-success 时重置；
        // parse-error continue 不再重置 max-tokens、保 strike independence
        consecutiveMaxTokensToolUse = 0;
      }

      // 3. onAfterStep（步进之后、熔断检查之后）
      if (onAfterStep) {
        await onAfterStep(result.meta, stepCount);
      }

      continue;
    }

    if (result.kind === 'max_tokens_tool_use') {
      consecutiveMaxTokensToolUse++;
      // Strike 2: warn agent before termination at strike 3
      if (consecutiveMaxTokensToolUse === maxConsecutiveMaxTokensToolUse - 1) {
        messages.push({
          role: 'user' as const,
          content: `[system warning] 连续 ${consecutiveMaxTokensToolUse} 次因 token 上限截断工具调用。下一次将终止当前任务。请将内容拆分为多次较小的调用。`,
        });
      }
      if (consecutiveMaxTokensToolUse >= maxConsecutiveMaxTokensToolUse) {
        throw new ConsecutiveMaxTokensToolUseError(maxConsecutiveMaxTokensToolUse);
      }
      stepCount++;

      // phase 337 M4 (review-2026-06-13): max_tokens_tool_use 分支也调 onAfterStep
      // 与 'continue' 分支对齐。否则该步 session save / contract auditor maybeAuditStep
      // / inbox check 全跳、违 DP「运行中信息不丢弃」。
      if (onAfterStep) {
        await onAfterStep(result.meta, stepCount);
      }

      continue;
    }

    // TS exhaustiveness
    const _exhaustive: never = result;
    throw new Error(`Unexpected StepResult: ${JSON.stringify(_exhaustive)}`);
  }

  throw new MaxStepsExceededError(maxSteps);
}
