/**
 * LLM Service module (F2)
 * Phase 0: Anthropic adapter + failover service
 * 
 * Exports: LLMService interface, LLMServiceImpl implementation, AnthropicAdapter
 */

// Internal types
export type {
  ProviderConfig,
  LLMServiceConfig,
  LLMCallOptions,
  StreamChunk,
  ProviderAdapter,
} from './types.js';

// Import for interface definition
import type { LLMResponse } from '../../types/message.js';
import type { LLMCallOptions, StreamChunk } from './types.js';

// Implementation
export { LLMServiceImpl } from './service.js';
export { AnthropicAdapter } from './anthropic.js';
export { CustomAnthropicAdapter } from './custom-anthropic.js';

// Abort helper
export { withCombinedAbortSignal, type CombinedAbortHandle } from './abort-helper.js';

/**
 * LLMService interface
 * 
 * Implemented by LLMServiceImpl class.
 */
export interface LLMService {
  call(options: LLMCallOptions): Promise<LLMResponse>;
  stream(options: LLMCallOptions): AsyncIterableIterator<StreamChunk>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): { name: string; model: string; isFallback: boolean };
  close(): Promise<void>;
}
