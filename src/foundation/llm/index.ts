/**
 * @module L1.LLMService
 * LLM Service module (F2)
 * Phase 0: Anthropic adapter + failover service
 *
 * NOTE: L1 LLMProvider + L2 LLMOrchestrator physical split (phase413).
 * Old path retained as re-export shim for backward compatibility.
 * Callers should migrate to:
 *   - L1: import from '../llm-provider/index.js'
 *   - L2: import from '../llm-orchestrator/index.js'
 */

// Re-export from new L1 module
export {
  AnthropicAdapter,
  CustomAnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  createLLMProvider,
  type LLMProvider,
  type ProviderAdapter,
  type ProviderConfig,
  type LLMCallOptions,
  type StreamChunk,
  LLMProviderError,
  withCombinedAbortSignal,
  type CombinedAbortHandle,
  type ApiFormat,
  type ProviderPreset,
  PRESETS,
  resolvePreset,
} from '../llm-provider/index.js';

// Re-export from new L2 module
export {
  LLMOrchestratorImpl,
  createLLMOrchestrator,
  LLMOrchestratorError,
  type LLMOrchestrator,
  type LLMOrchestratorConfig,
  type LLMEventSink,
  type LLMEvent,
} from '../llm-orchestrator/index.js';

// Legacy alias exports (backward compatibility — will be removed after all callers migrate)
export type { LLMOrchestrator as LLMService } from '../llm-orchestrator/index.js';
export type { LLMOrchestratorConfig as LLMServiceConfig } from '../llm-orchestrator/index.js';
export { LLMOrchestratorImpl as LLMServiceImpl } from '../llm-orchestrator/index.js';
export { createLLMOrchestrator as createLLMService } from '../llm-orchestrator/index.js';
