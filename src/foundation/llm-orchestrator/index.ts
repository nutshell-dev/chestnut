/**
 * @module L2.LLMOrchestrator
 * LLM Orchestrator module (L2) — multi-provider fault-tolerant orchestration
 *
 * Exports: LLMOrchestrator interface, LLMOrchestratorImpl implementation,
 *          createLLMOrchestrator factory
 */

import type { LLMOrchestratorConfig, LLMOrchestrator } from './types.js';

export { LLMOrchestratorImpl } from './orchestrator.js';
export type {
  LLMOrchestratorConfig,
  LLMEventSink,
  LLMEvent,
  StreamChunk,
  LLMCallOptions,
  ProviderConfig,
  ProviderAdapter,
  LLMOrchestrator,
} from './types.js';

import { LLMOrchestratorImpl } from './orchestrator.js';

export function createLLMOrchestrator(config: LLMOrchestratorConfig): LLMOrchestrator {
  return new LLMOrchestratorImpl(config);
}

export { DEFAULT_LLM_IDLE_TIMEOUT_MS, INIT_LLM_IDLE_TIMEOUT_MS } from './defaults.js';

