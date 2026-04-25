/**
 * Agent Executor - Multi-step agent loop with persistence and circuit breakers
 *
 * Repeatedly calls StepExecutor (executeStep) until a final result or exception.
 * Maintains cross-step counters (stepCount, consecutiveParseErrors,
 * consecutiveMaxTokensToolUse) and persists session after each successful step.
 */

import type { Message, ToolDefinition } from '../../types/message.js';
import type { LLMService } from '../../foundation/llm/index.js';
import type { IToolExecutor, ExecContext, ToolRegistry } from '../tools/executor.js';
import type { SessionManager } from '../../foundation/session-store/index.js';
import { executeStep, type StepCallbacks, type StepMeta } from './step-executor.js';
import { throwAbortError } from './abort-helpers.js';
import { MaxStepsExceededError, ConsecutiveParseErrorsExceededError, ConsecutiveMaxTokensToolUseError } from '../../types/errors.js';
import { MAX_CONSECUTIVE_PARSE_ERRORS, MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE } from '../../constants.js';

export interface AgentInput {
  messages: Message[];
  systemPrompt: string;
  llm: LLMService;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;
  ctx: ExecContext;

  sessionStore?: SessionManager;       // 可选：未提供则跳过落盘

  maxSteps?: number;                   // 默认 20
  maxTokens?: number;                  // 透传给 executeStep
  idleTimeoutMs?: number;              // 透传给 StepInput
  stepCallbacks?: StepCallbacks;
  onAfterStep?: (meta: StepMeta) => void | Promise<void>;
}

export interface AgentResult {
  finalText: string;
  stepsUsed: number;
  stopReason: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown';
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const {
    messages, systemPrompt, llm, tools, executor, registry, ctx,
    sessionStore,
    maxTokens,
    stepCallbacks,
    onAfterStep,
  } = input;
  const maxSteps = input.maxSteps ?? 20;

  let stepCount = 0;
  let consecutiveParseErrors = 0;
  let consecutiveMaxTokensToolUse = 0;

  while (stepCount < maxSteps) {
    ctx.stepNumber = stepCount;
    if (ctx.signal?.aborted) throwAbortError(ctx.signal);

    const result = await executeStep({
      messages, systemPrompt, llm, tools, executor, registry, ctx,
      maxTokens,
      idleTimeoutMs: input.idleTimeoutMs,
      callbacks: stepCallbacks,
    });

    if (result.kind === 'final') {
      return {
        finalText: result.finalText,
        stepsUsed: stepCount,
        stopReason: result.stopReason,
      };
    }

    if (result.kind === 'context_window_exceeded') {
      throw new Error(
        `LLM context window exceeded. Reduce system prompt, tool definitions, or conversation history.`
      );
    }

    if (result.kind === 'continue') {
      // 1. 落盘
      if (sessionStore) {
        await sessionStore.save(messages);
      }

      // 2. 步进
      ctx.incrementStep();
      stepCount = ctx.stepNumber;

      // 3. 熔断判定（parse errors）
      if (result.meta.allParseErrors) {
        consecutiveParseErrors++;
        if (consecutiveParseErrors >= MAX_CONSECUTIVE_PARSE_ERRORS) {
          // 从最近一条 assistant 消息的 tool_use blocks 提取工具名（为错误消息保留上下文）
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          const toolNames = Array.isArray(lastAssistant?.content)
            ? lastAssistant!.content
                .filter((b): b is { type: 'tool_use'; name: string } => (b as { type?: string }).type === 'tool_use')
                .map(b => b.name)
                .join(', ')
            : '';
          throw new ConsecutiveParseErrorsExceededError(MAX_CONSECUTIVE_PARSE_ERRORS, toolNames);
        }
      } else {
        consecutiveParseErrors = 0;
      }
      consecutiveMaxTokensToolUse = 0;

      // 4. onAfterStep（save 之后、熔断检查之后）
      if (onAfterStep) {
        await onAfterStep(result.meta);
      }

      continue;
    }

    if (result.kind === 'max_tokens_tool_use') {
      consecutiveMaxTokensToolUse++;
      if (consecutiveMaxTokensToolUse >= MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE) {
        throw new ConsecutiveMaxTokensToolUseError(MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE);
      }
      // 不 stepCount++、不 save、不 onAfterStep
      continue;
    }

    // TS exhaustiveness
    const _exhaustive: never = result;
    throw new Error(`Unexpected StepResult: ${JSON.stringify(_exhaustive)}`);
  }

  throw new MaxStepsExceededError(maxSteps);
}
