/**
 * ReAct loop - backwards-compat shim over AgentExecutor + StepExecutor
 *
 * 对外保持原 runReact 签名不变。内部把旧的 11 个平铺回调 + onStepComplete
 * 适配到新契约：StepCallbacks（给 StepExecutor） + onAfterStep（给 AgentExecutor）。
 *
 * 真实实现见 step-executor.ts 和 agent-executor.ts。
 */

import type { Message, ToolDefinition } from '../../types/message.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext, ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import { runAgent } from './agent-executor.js';
import type { StepCallbacks, LLMCallInfo } from '../step-executor/step-executor.js';

export interface ReactOptions {
  messages: Message[];
  systemPrompt: string;
  llm: LLMOrchestrator;
  executor: IToolExecutor;
  ctx: ExecContext;
  maxSteps?: number;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  idleTimeoutMs?: number;
  onToolCall?: (toolName: string, toolUseId: string) => void | Promise<void>;
  onBeforeLLMCall?: () => void;
  onToolResult?: (toolName: string, toolUseId: string, result: ToolResult, step: number, maxSteps: number) => void;
  onStepComplete?: () => Promise<void>;
  tools?: ToolDefinition[];
  registry?: ToolRegistry;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onReset?: (provider: string, timeoutMs: number) => void;
  onProviderFailed?: (provider: string, model: string, error: string) => void;
  onLLMResult?: (info: LLMCallInfo) => void;
  onEmptyResponse?: (stopReason: string) => void;
  onUnknownStopReason?: (stopReason: string) => void;
  onUnparseableToolUse: (stopReason: string) => void;
  onSafeCallbackError?: (label: string, err: unknown) => void;
}

export interface ReactResult {
  finalText: string;
  stepsUsed: number;
  // phase 788: 'unknown' propagate（audit-2026-05-14 P0.15）
  // LLM 返 unrecognized stop_reason（refusal、content_filter、safety、stop_sequence 等）
  // 经 step-executor 映射 'unknown'，本字段保留 'unknown' 给 caller 区分 true end_turn
  stopReason: 'end_turn' | 'no_tool' | 'max_tokens' | 'unknown';
}

export async function runReact(options: ReactOptions): Promise<ReactResult> {
  const {
    messages, systemPrompt, llm, executor, ctx,
    maxSteps = 20,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    onToolCall, onBeforeLLMCall, onToolResult, onStepComplete,
    tools = [],
    registry,
    onTextDelta, onTextEnd, onThinkingDelta,
    onReset, onProviderFailed, onLLMResult,
    onEmptyResponse, onUnknownStopReason, onUnparseableToolUse, onSafeCallbackError,
  } = options;

  // 用闭包捕获 stepCount（适配旧 onToolResult 签名的 step/maxSteps 参数）
  let stepCount = 0;

  const stepCallbacks: StepCallbacks = {
    onBeforeLLMCall,
    onLLMResult,
    onTextDelta,
    onTextEnd,
    onThinkingDelta,
    onToolCall,
    onToolResult: onToolResult
      ? (name, toolUseId, result) => onToolResult(name, toolUseId, result, stepCount, maxSteps)
      : undefined,
    onReset,
    onProviderFailed,
    onEmptyResponse,
    onUnknownStopReason,
    onUnparseableToolUse,
    onSafeCallbackError,
  };

  const result = await runAgent({
    messages, systemPrompt, llm, tools, executor, registry, ctx,
    maxSteps,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    stepCallbacks,
    onAfterStep: async () => {
      stepCount = ctx.stepNumber;  // incrementStep 已被 AgentExecutor 执行
      if (onStepComplete) await onStepComplete();
    },
    // dialogStore 不传：shim 不依赖 DialogStore（由调用方通过 onStepComplete 自己处理）
  });

  return {
    finalText: result.finalText,
    stepsUsed: result.stepsUsed,
    stopReason: mapStopReason(result.stopReason),
  };
}

function mapStopReason(
  r: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown'
): 'end_turn' | 'no_tool' | 'max_tokens' | 'unknown' {
  if (r === 'max_tokens_text') return 'max_tokens';
  if (r === 'no_tool') return 'no_tool';
  if (r === 'unknown') return 'unknown';   // phase 788: propagate refusal/safety/etc 不折叠 end_turn
  return 'end_turn';  // 默 'end_turn'（仅 true end_turn 到达）
}
