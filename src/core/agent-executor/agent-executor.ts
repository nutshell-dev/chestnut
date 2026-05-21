/**
 * Agent Executor - Multi-step agent loop with persistence and circuit breakers
 *
 * Repeatedly calls StepExecutor (executeStep) until a final result or exception.
 * Maintains cross-step counters (stepCount, consecutiveParseErrors,
 * consecutiveMaxTokensToolUse) and persists session after each successful step.
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import { executeStep, type StepCallbacks, type StepMeta } from '../step-executor/step-executor.js';
import { throwAbortError } from '../step-executor/abort-helpers.js';
import { MaxStepsExceededError, ConsecutiveParseErrorsExceededError, ConsecutiveMaxTokensToolUseError, WallTimeExceededError } from './errors.js';
import { DEFAULT_MAX_STEPS } from './defaults.js';
import { MAX_CONSECUTIVE_PARSE_ERRORS, MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE } from './constants.js';

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
  onAfterStep?: (meta: StepMeta) => void | Promise<void>;
}

export interface AgentResult {
  finalText: string;
  stepsUsed: number;
  stopReason: 'end_turn' | 'stop' | 'max_tokens_text' | 'no_tool' | 'content_filter' | 'unknown';
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const {
    messages, systemPrompt, llm, tools, executor, registry, ctx,
    maxTokens,
    stepCallbacks,
    onAfterStep,
  } = input;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxConsecutiveParseErrors = input.maxConsecutiveParseErrors ?? MAX_CONSECUTIVE_PARSE_ERRORS;
  const maxConsecutiveMaxTokensToolUse = input.maxConsecutiveMaxTokensToolUse ?? MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE;

  let stepCount = 0;
  let consecutiveParseErrors = 0;
  let consecutiveMaxTokensToolUse = 0;

  const startMs = Date.now();
  const deadline = input.wallTimeDeadlineMs;

  while (stepCount < maxSteps) {
    if (deadline !== undefined) {
      const elapsed = Date.now() - startMs;
      if (elapsed > deadline) {
        throw new WallTimeExceededError(deadline, elapsed);
      }
    }
    ctx.stepNumber = stepCount;
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);
    // phase 777: result-capture tools (done) request early stop.
    // capturedResult is read by runSubagent regardless of finalText.
    if (ctx.stopRequested) {
      return { finalText: '', stepsUsed: stepCount, stopReason: 'end_turn' };
    }

    const result = await executeStep({
      messages, systemPrompt, llm, tools, executor, registry, ctx,
      maxTokens,
      idleTimeoutMs: input.idleTimeoutMs,
      callbacks: stepCallbacks,
    });

    if (result.kind === 'final') {
      return {
        finalText: result.finalText || (result.stopReason === 'content_filter' ? '[Content filtered]' : result.finalText),
        stepsUsed: stepCount,
        stopReason: result.stopReason,
      };
    }

    if (result.kind === 'continue') {
      // 1. 步进（落盘归 caller 经 onStepComplete callback / phase409 align M#1+M#3）
      ctx.incrementStep();
      stepCount = ctx.stepNumber;

      // 2. 熔断判定（parse errors）
      if (result.meta.allParseErrors) {
        consecutiveParseErrors++;
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
      }
      consecutiveMaxTokensToolUse = 0;

      // 3. onAfterStep（步进之后、熔断检查之后）
      if (onAfterStep) {
        await onAfterStep(result.meta);
      }

      continue;
    }

    if (result.kind === 'max_tokens_tool_use') {
      consecutiveMaxTokensToolUse++;
      if (consecutiveMaxTokensToolUse >= maxConsecutiveMaxTokensToolUse) {
        throw new ConsecutiveMaxTokensToolUseError(maxConsecutiveMaxTokensToolUse);
      }
      ctx.incrementStep?.();
      stepCount = ctx.stepNumber;
      continue;
    }

    // TS exhaustiveness
    const _exhaustive: never = result;
    throw new Error(`Unexpected StepResult: ${JSON.stringify(_exhaustive)}`);
  }

  throw new MaxStepsExceededError(maxSteps);
}
