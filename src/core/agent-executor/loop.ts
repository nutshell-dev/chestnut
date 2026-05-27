/**
 * ReAct loop - **facade pattern (long-term ratify per phase 1180 r129 E fork)**
 *
 * 对外保持原 `runReact` 签名（11 平铺回调 + onStepComplete）作为稳定 API、
 * 内部 adapt 到新契约：StepCallbacks（给 StepExecutor） + onAfterStep（给 AgentExecutor）。
 * 真实实现见 step-executor.ts 和 agent-executor.ts。
 *
 * **NOT a transitional shim** — runtime.ts 3 site 真生产依赖、tests/ 6 file mock + import
 * facade-pattern 长留稳定、0 sunset 计划 / 升档锚：if NEW caller 同型「11 平铺回调展平」需求出现 N≥2
 * → 抽 generic `ReactFacade` (per phase 1180 升档锚 (a))
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import { DEFAULT_MAX_STEPS } from './defaults.js';
import { runAgent } from './agent-executor.js';
import type { StepCallbacks, LLMCallInfo } from '../step-executor/step-executor.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';


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
  wallTimeDeadlineMs?: number;
  onToolCall?: (toolName: string, toolUseId: ToolUseId) => void | Promise<void>;
  onBeforeLLMCall?: () => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: ToolResult, step: number, maxSteps: number) => void;
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
  onToolInputParseError?: (toolName: string, toolUseId: ToolUseId, rawInput: string) => void;
  onToolExecutionFailed?: (toolName: string, toolUseId: ToolUseId, errorType: string, errorMsg: string) => void;
  onSafeCallbackError?: (label: string, err: unknown) => void;
  onMaxTokensPrebuiltOnlyFinal?: (meta: { prebuiltCount: number; llm: LLMCallInfo }) => void;
  onMaxTokensAssistantEmptySkipped?: (meta: { llm: LLMCallInfo }) => void;
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
    maxSteps = DEFAULT_MAX_STEPS,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    wallTimeDeadlineMs,
    onToolCall, onBeforeLLMCall, onToolResult, onStepComplete,
    tools = [],
    registry,
    onTextDelta, onTextEnd, onThinkingDelta,
    onReset, onProviderFailed, onLLMResult,
    onEmptyResponse, onUnknownStopReason, onUnparseableToolUse, onToolInputParseError, onToolExecutionFailed, onSafeCallbackError,
    onMaxTokensPrebuiltOnlyFinal, onMaxTokensAssistantEmptySkipped,
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
    onToolInputParseError,
    onToolExecutionFailed,
    onSafeCallbackError,
    onMaxTokensPrebuiltOnlyFinal,
    onMaxTokensAssistantEmptySkipped,
  };

  const result = await runAgent({
    messages, systemPrompt, llm, tools, executor, registry, ctx,
    maxSteps,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    wallTimeDeadlineMs,
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
  r: 'end_turn' | 'stop' | 'max_tokens_text' | 'no_tool' | 'content_filter' | 'unknown'
): 'end_turn' | 'no_tool' | 'max_tokens' | 'unknown' {
  if (r === 'max_tokens_text') return 'max_tokens';
  if (r === 'no_tool') return 'no_tool';
  if (r === 'unknown' || r === 'content_filter') return 'unknown';   // phase 788: propagate refusal/safety/etc 不折叠 end_turn
  return 'end_turn';  // 'end_turn' 与 'stop' 均映射为 'end_turn'（向后兼容 shim）
}
