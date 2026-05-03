/**
 * @module L1.LLMProvider
 * LLM Provider module (L1) — single provider call primitives
 *
 * Exports: LLMProvider interface, provider adapters, factory
 */

import type { LLMResponse } from '../../types/message.js';
import type { ProviderConfig, LLMCallOptions, StreamChunk, ProviderAdapter } from './types.js';
import { AnthropicAdapter } from './anthropic.js';
import { CustomAnthropicAdapter } from './custom-anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';

export type {
  ProviderConfig,
  LLMCallOptions,
  StreamChunk,
  ProviderAdapter,
} from './types.js';

export { AnthropicAdapter } from './anthropic.js';
export { CustomAnthropicAdapter } from './custom-anthropic.js';
export { OpenAIAdapter } from './openai.js';
export { GeminiAdapter } from './gemini.js';
export { withCombinedAbortSignal, type CombinedAbortHandle } from './abort-helper.js';
export type { ApiFormat, ProviderPreset } from './presets.js';
export { PRESETS, resolvePreset } from './presets.js';

/**
 * LLMProvider interface — single provider call primitive
 *
 * Implemented by all provider adapters (Anthropic, OpenAI, Gemini, etc.)
 */
export interface LLMProvider extends ProviderAdapter {}

/**
 * LLMProviderError — typed error for provider-level failures
 */
export class LLMProviderError extends Error {
  readonly code: 'network' | 'provider_error' | 'invalid_request' | 'unknown';
  readonly provider: string;

  constructor(
    message: string,
    code: 'network' | 'provider_error' | 'invalid_request' | 'unknown',
    provider: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.code = code;
    this.provider = provider;
    this.name = 'LLMProviderError';
  }
}

/**
 * Provider factory — creates appropriate adapter for config
 */
export function createLLMProvider(config: ProviderConfig): LLMProvider {
  // Allow passing a pre-built adapter directly (used in tests)
  if ('stream' in config && typeof (config as any).stream === 'function') {
    return config as unknown as LLMProvider;
  }
  if (config.apiFormat === 'openai') return new OpenAIAdapter(config);
  if (config.apiFormat === 'gemini') return new GeminiAdapter(config);
  // anthropic format: Claude models use SDK (native API), others use raw fetch
  const isClaude = config.model.toLowerCase().includes('claude');
  return isClaude ? new AnthropicAdapter(config) : new CustomAnthropicAdapter(config);
}
