/**
 * @module L3.StepExecutor.Types
 * Step type definitions — extracted from step-executor.ts
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext, IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';


export interface LLMCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
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
}

export interface StepMeta {
  toolCallCount: number;
  parseErrorCount: number;
  allParseErrors: boolean;
  llm: LLMCallInfo;
  /** Stream-layer parse-error tool names (when no tool_use blocks exist in assistant message) */
  toolNames?: string;
}

/**
 * StepResult 'final' variant 的 stopReason 字面联合。
 * phase 1483: 抽 named type、让 AgentExecutor 编译期复用、消除独立字面声明漂移风险（M#9 编译器可检）。
 */
export type FinalStopReason = 'end_turn' | 'stop' | 'max_tokens_text' | 'no_tool' | 'content_filter' | 'unknown';

export type StepResult =
  | { kind: 'final'; stopReason: FinalStopReason; finalText: string }
  | { kind: 'continue'; meta: StepMeta }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta };
