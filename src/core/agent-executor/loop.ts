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

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { assertNever } from '../../foundation/utils/index.js';
import { DEFAULT_MAX_STEPS } from './defaults.js';
import { runAgent } from './agent-executor.js';
import type { StepCallbacks, LLMCallInfo, FinalStopReason } from '../step-executor/index.js';
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
  /** phase 1411: fires when tool args fully parsed (post-stream, pre-execute). See StepCallbacks.onToolCallInput. */
  onToolCallInput?: (toolName: string, toolUseId: ToolUseId, args: Record<string, unknown>) => void;
  /** phase 688: fires inside flushToolUse (stream + catch drain). See StepCallbacks.onToolUseInput. */
  onToolUseInput?: (toolName: string, toolUseId: ToolUseId, input: Record<string, unknown>) => void;
  /** phase 688: fires in collector catch path after drain; carries discard 决策摘要. */
  onPartialAssistantDiscarded?: (info: {
    cause: 'all_providers_failed' | 'idle_timeout' | 'unknown';
    toolUseCount: number;
    hasText: boolean;
    hasThinking: boolean;
    startTs: number;
    endTs: number;
    errMessage: string;
  }) => void;
  onBeforeLLMCall?: () => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: ToolResult, step: number, maxSteps: number) => void;
  /** phase 706: receives the step count after a successful step for caller persistence/audit. */
  onStepComplete?: (stepCount: number) => Promise<void>;
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
  /** phase 1383: State A orphan prebuilt drop observability */
  onMaxTokensStateAOrphanDrop?(args: {
    orphans: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
    llm: LLMCallInfo;
  }): void;
  // phase 706: AgentExecutor needs audit writer + per-turn contract id for tool_call_input.
  auditWriter?: AuditLog;
  currentContractId?: string;
  // phase 690: 撤 dialogStore + contextManagerConfig — proactive trim
  // 上提到 L5 Runtime 反应式 retry 路径、loop.ts facade 不再透传。
}

export interface ReactResult {
  finalText: string;
  stepsUsed: number;
  // phase 788: 'unknown' propagate（audit-2026-05-14 P0.15）
  // LLM 返 unrecognized stop_reason（refusal、safety、stop_sequence 等）经 step-executor 映射 'unknown'，本字段保留区分 true end_turn。
  // phase 1483: 'content_filter' 字面单独保留（不再折叠为 'unknown'）— Design Principle「运行中信息不丢弃」+ 唯一 caller subagent/agent.ts:411 仅 appendToLog 字符串拼接安全。
  stopReason: 'end_turn' | 'no_tool' | 'max_tokens' | 'content_filter' | 'unknown';
}

export async function runReact(options: ReactOptions): Promise<ReactResult> {
  const {
    messages, systemPrompt, llm, executor, ctx,
    maxSteps = DEFAULT_MAX_STEPS,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    wallTimeDeadlineMs,
    onToolCall, onToolCallInput, onToolUseInput, onPartialAssistantDiscarded, onBeforeLLMCall, onToolResult, onStepComplete,
    tools = [],
    registry,
    onTextDelta, onTextEnd, onThinkingDelta,
    onReset, onProviderFailed, onLLMResult,
    onEmptyResponse, onUnknownStopReason, onUnparseableToolUse, onToolInputParseError, onToolExecutionFailed, onSafeCallbackError,
    onMaxTokensPrebuiltOnlyFinal, onMaxTokensAssistantEmptySkipped,
    auditWriter,
    currentContractId,
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
    onToolCallInput,
    onToolUseInput,
    onPartialAssistantDiscarded,
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
    auditWriter,
    currentContractId,
    onAfterStep: async (_meta, newStepCount) => {
      stepCount = newStepCount;  // AgentExecutor 已执行步进
      if (onStepComplete) await onStepComplete(stepCount);
    },
  });

  return {
    finalText: result.finalText,
    stepsUsed: result.stepsUsed,
    stopReason: mapStopReason(result.stopReason),
  };
}

function mapStopReason(
  r: FinalStopReason
): 'end_turn' | 'no_tool' | 'max_tokens' | 'content_filter' | 'unknown' {
  // phase 398 Step C (review N8): switch + assertNever default — 新 FinalStopReason
  // 变体编译期失败 (vs phase 1483 / 788 if-cascade + 'end_turn' default 静默折叠)。
  switch (r) {
    case 'max_tokens_text': return 'max_tokens';
    case 'no_tool': return 'no_tool';
    case 'content_filter': return 'content_filter';   // phase 1483 distinct propagate
    case 'unknown': return 'unknown';                 // phase 788 distinct propagate
    case 'end_turn':
    case 'stop':
      return 'end_turn';  // 'end_turn' 与 'stop' 均映射为 'end_turn'（向后兼容 shim）
    default:
      return assertNever(r);
  }
}
