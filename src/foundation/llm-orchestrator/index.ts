/**
 * @module L2.LLMOrchestrator
 * LLM Orchestrator module (L2) — multi-provider fault-tolerant orchestration
 *
 * Exports: LLMOrchestrator interface, LLMOrchestratorImpl implementation,
 *          createLLMOrchestrator factory
 */

import type { LLMResponse } from '../../types/message.js';
import type { LLMCallOptions, StreamChunk } from './types.js';

export { LLMOrchestratorImpl } from './orchestrator.js';
export type {
  LLMOrchestratorConfig,
  LLMEventSink,
  LLMEvent,
  StreamChunk,
  LLMCallOptions,
  ProviderConfig,
  ProviderAdapter,
} from './types.js';

import { LLMOrchestratorImpl } from './orchestrator.js';
import type { LLMOrchestratorConfig } from './types.js';

export function createLLMOrchestrator(config: LLMOrchestratorConfig): LLMOrchestrator {
  return new LLMOrchestratorImpl(config);
}

/**
 * LLMOrchestrator interface — multi-provider fault-tolerant LLM orchestration
 *
 * Implemented by LLMOrchestratorImpl class.
 */
export interface LLMOrchestrator {
  call(options: LLMCallOptions): Promise<LLMResponse>;
  stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): { name: string; model: string; isFallback: boolean } | null;
  close(): Promise<void>;
}

/**
 * LLMOrchestratorError — typed error for orchestrator-level failures
 */
export class LLMOrchestratorError extends Error {
  readonly code: 'all_providers_failed' | 'context_exceeded' | 'max_tokens' | 'aborted' | 'unknown';

  constructor(
    message: string,
    code: 'all_providers_failed' | 'context_exceeded' | 'max_tokens' | 'aborted' | 'unknown',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.code = code;
    this.name = 'LLMOrchestratorError';
  }
}
