/**
 * @module L1.LLMProvider
 * LLM Provider module (L1) — single provider call primitives
 *
 * Exports: LLMProvider interface, provider adapters, factory
 */

export type {
  ProviderConfig,
  LLMCallOptions,
  ProviderStreamChunk,
  ProviderAdapter,
  AuditSink,
} from './types.js';

export {
  withCombinedAbortSignal,
  type AbortReason,
  makeExternalAbortError,
  ExternalAbortError,
} from './abort-helper.js';
export { PRESETS, resolvePreset } from './presets.js';

export type { Message, LLMResponse, ContentBlock, ToolUseBlock, ToolResultBlock, ToolDefinition, ThinkingBlock, JSONSchema7, TextBlock } from './types.js';
export { LLMInvalidRequestError } from './request-unicode.js';

export {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
} from './token-estimator.js';

// phase 691 Step A: ToolUseId 物理位置从 tool-protocol（L2b）迁回 L1 LLMProvider canonical owner
// SoT: Anthropic LLM protocol (tool_use block id) — 与 L1 protocol primitive 同语义层
export type { ToolUseId } from './tool-use-id.js';
export { makeToolUseId } from './tool-use-id.js';

export { LLMError, LLMRateLimitError, LLMTimeoutError, LLMAuthError, LLMNetworkError, LLMEmptyResponseError, LLMModelNotFoundError, LLMContextExceededError, LLMOutputBudgetExceededError, LLMCircuitBreakerOpenError, LLMStreamAbortedError } from './errors.js';

export { isAbortError } from './is-abort-error.js';

export { resolveContextWindow } from './model-context-windows.js';

export type { LLMProvider } from './types.js';
export { createLLMProvider } from './provider-factory.js';
