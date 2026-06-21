/**
 * @module L3.StepExecutor.Types
 * Step type definitions — extracted from step-executor.ts
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext, IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';

export interface LLMCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
}

/**
 * phase 440: ContextManager runtime config injected at assembly time.
 */
export interface ContextManagerRuntimeConfig {
  filterSubtypes: ReadonlySet<string>;
}

export interface StepCallbacks {
  onBeforeLLMCall?: () => void;
  onLLMResult?: (info: LLMCallInfo) => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: ToolUseId) => void | Promise<void>;
  /**
   * phase 1411: fires after args fully parsed (post LLM stream complete) and
   * before executor.execute. Carries full args (post parse-failure guard).
   *
   * Distinct from onToolCall (tool_use_start, args not yet streamed) —
   * onToolCallInput is the audit-quality emit point. SubAgent uses it to emit
   * `tool_call_input` index row (name + tool_use_id + args_size) per
   * design/modules/l3_subagent.md §A.phase1409-on-tool-call-args-emit
   * (amended-by phase 1411).
   */
  onToolCallInput?: (toolName: string, toolUseId: ToolUseId, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: ToolResult) => void;
  onReset?: (provider: string, timeoutMs: number) => void;
  onProviderFailed?: (provider: string, model: string, error: string) => void;
  onEmptyResponse?: (stopReason: string) => void;
  onUnknownStopReason?: (stopReason: string) => void;
  onUnparseableToolUse: (stopReason: string) => void;
  onToolInputParseError?: (toolName: string, toolUseId: ToolUseId, rawInput: string) => void;
  onToolExecutionFailed?: (toolName: string, toolUseId: ToolUseId, errorType: string, errorMsg: string) => void;
  onSafeCallbackError?: (label: string, err: unknown) => void;
  onMessageAppended?: (role: 'assistant' | 'user', blocks: number) => void;
  onMaxTokensPrebuiltOnlyFinal?: (meta: { prebuiltCount: number; llm: LLMCallInfo }) => void;
  onMaxTokensAssistantEmptySkipped?: (meta: { llm: LLMCallInfo }) => void;
  /** phase 1383: State A orphan prebuilt drop observability */
  onMaxTokensStateAOrphanDrop?(args: {
    orphans: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
    llm: LLMCallInfo;
  }): void;
}

export interface StepInput {
  messages: Message[];
  systemPrompt: string;
  llm: LLMOrchestrator;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;
  ctx: ExecContext;
  maxTokens?: number;
  idleTimeoutMs?: number;
  callbacks?: StepCallbacks;
  dialogStore?: DialogStore;                          // ← NEW phase 440：触底裁要 archive + save
  contextManagerConfig?: ContextManagerRuntimeConfig; // ← NEW phase 440：filterSubtypes 等
}

export interface StepMeta {
  toolCallCount: number;
  parseErrorCount: number;
  allParseErrors: boolean;
  llm: LLMCallInfo;
  /** Stream-layer parse-error tool names (when no tool_use blocks exist in assistant message) */
  toolNames?: string;
}

/** Brand symbol — caller 无法构造、唯一通道是 asFinalStopReason factory */
declare const __FSR_brand: unique symbol;

/**
 * FinalStopReason 单源 const（M#3 资源唯一归属、ML#1 共用基础设施单源）。
 *
 * Producer 必经 asFinalStopReason() / tryAsFinalStopReason() 构造、
 * 不可直接字面 string assign 到 FinalStopReason type（brand 阻挡）。
 */
export const FINAL_STOP_REASONS = [
  'end_turn',
  'stop',
  'max_tokens_text',
  'no_tool',
  'content_filter',
  'unknown',
] as const;

type RawFinalStopReason = typeof FINAL_STOP_REASONS[number];

/**
 * 字面联合 + brand intersection。
 * caller 写 `const x: FinalStopReason = 'end_turn'` 编译 fail（缺 brand）。
 * caller 必经 `asFinalStopReason('end_turn')` 构造（M#9 优先编译期检查）。
 */
export type FinalStopReason = (RawFinalStopReason & { readonly [__FSR_brand]: never });

/**
 * 唯一构造入口（producer 已知 RawFinalStopReason value）。
 */
export function asFinalStopReason(s: RawFinalStopReason): FinalStopReason {
  return s as FinalStopReason;
}

/**
 * Raw LLM string → typed FinalStopReason validate + 构造。
 * 用于 step-executor.ts:98 dynamic 路径（raw LLM response.stop_reason）。
 * 返回 undefined 时 caller 应走 onUnknownStopReason callback + fallback。
 */
export function tryAsFinalStopReason(s: string): FinalStopReason | undefined {
  return (FINAL_STOP_REASONS as readonly string[]).includes(s)
    ? (s as FinalStopReason)
    : undefined;
}

export type StepResult =
  | { kind: 'final'; stopReason: FinalStopReason; finalText: string; newMessages?: Message[] }
  | { kind: 'continue'; meta: StepMeta; newMessages?: Message[] }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta; newMessages?: Message[] };
