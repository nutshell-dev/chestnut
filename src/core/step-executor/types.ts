/**
 * @module L3.StepExecutor.Types
 * Step type definitions — extracted from step-executor.ts
 */

import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
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
}

export interface StepInput {
  messages: Message[];
  systemPrompt: string;
  llm: LLMOrchestrator;
  tools: ToolDefinition[];
  executor: import('../../foundation/tools/index.js').IToolExecutor;
  registry?: import('../../foundation/tools/index.js').ToolRegistry;
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

export type StepResult =
  | { kind: 'final'; stopReason: 'end_turn' | 'stop' | 'max_tokens_text' | 'no_tool' | 'content_filter' | 'unknown'; finalText: string }
  | { kind: 'continue'; meta: StepMeta }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta };
