/**
 * @module L1.LLMProvider
 * Single-provider owner with narrow capability façades.
 *
 * Cross-module callers import only their assigned façade. The named exports at
 * the bottom are the root package compatibility surface, not an omnibus API.
 */
export * as llmProviderCall from './capabilities/call.js';
export * as llmProviderProtocol from './capabilities/protocol.js';
export * as llmProviderModelMeasurement from './capabilities/model-measurement.js';
export * as llmProviderConfigContract from './capabilities/config-contract.js';
export * as llmProviderCatalog from './capabilities/catalog.js';
export * as llmProviderCredentialRuntime from './capabilities/credential-runtime.js';
export * as llmProviderAbort from './capabilities/abort.js';

// ROOT_COMPAT_EXPORTS: consumed by src/index.ts; removal requires a public API migration.
export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ContentBlock,
  ToolDefinition,
  JSONSchema7,
} from './capabilities/protocol.js';
export type { LLMResponse } from './capabilities/call.js';
export {
  LLMError,
  LLMAuthError,
  LLMEmptyResponseError,
  LLMModelNotFoundError,
  LLMNetworkError,
  LLMRateLimitError,
  LLMQuotaError,
  LLMTimeoutError,
} from './capabilities/call.js';
export type { ProviderConfig } from './capabilities/config-contract.js';
