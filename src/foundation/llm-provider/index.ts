/**
 * @module L1.LLMProvider
 * LLM Provider module (L1) — single provider call primitives
 *
 * Exports: LLMProvider interface, provider adapters, factory
 */

export { THINKING_LEVELS } from './thinking-levels.js';
export type { ThinkingLevel } from './thinking-levels.js';
export { resolveThinkingDefaults } from './thinking-defaults.js';
export type { ResolvedThinkingDefaults } from './thinking-defaults.js';

export type {
  ProviderConfig,
  LLMCallOptions,
  ProviderStreamChunk,
  ProviderAdapter,
  AuditSink } from './types.js';

export {
  withCombinedAbortSignal,
  makeExternalAbortError,
  ExternalAbortError } from './abort-helper.js';
export { PRESETS, resolvePreset, presetAuthProfile, presetRequiresBaseUrl } from './presets.js';
export type { AuthProfile, PresetThinkingDefaults } from './presets.js';
// Phase 1927 Step D：显式 catalog provider 配置策略单源（CLI 经 barrel 触达）
export {
  UnknownCatalogProviderError,
  CatalogModelNotFoundError,
  catalogProviderEntry,
  isCatalogProvider,
  deriveCatalogAuthProfile,
  validateCatalogAuthProfile,
  catalogModelKnown,
  catalogProvidersWithoutPreset,
} from './catalog-strategy.js';
export {
  createPiAiCredentialStore,
  piAiCredentialRef,
} from './pi-ai-credentials.js';
export type { PiAiCredentialBackend, PiAiCredentialStore } from './pi-ai-credentials.js';
// Phase 1926 Step D：CLI login 缝经 barrel 触达运行时（no-deep-into-module 纪律）
export { loadPiAiRuntime } from './pi-ai-support.js';
export type { PiAiRuntime } from './pi-ai-support.js';

export type { ProviderWireMessage, LLMResponse, ContentBlock, ToolUseBlock, ToolResultBlock, ToolDefinition, ThinkingBlock, JSONSchema7, TextBlock } from './types.js';
export { LLMInvalidRequestError } from './request-unicode.js';

export {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateToolsTokens } from './token-estimator.js';

// phase 691 Step A: ToolUseId 物理位置从 tool-protocol（L2b）迁回 L1 LLMProvider canonical owner
// SoT: Anthropic LLM protocol (tool_use block id) — 与 L1 protocol primitive 同语义层
export type { ToolUseId } from './tool-use-id.js';
export { makeToolUseId } from './tool-use-id.js';

export { LLMError, LLMRateLimitError, LLMTimeoutError, LLMAuthError, LLMNetworkError, LLMEmptyResponseError, LLMModelNotFoundError, LLMContextExceededError, LLMOutputBudgetExceededError, LLMStreamAbortedError } from './errors.js';

export { isAbortError } from './is-abort-error.js';

export { resolveContextWindow } from './model-context-windows.js';

export type { LLMProvider } from './types.js';
export { createLLMProvider } from './provider-factory.js';
