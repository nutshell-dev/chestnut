import type { ProviderConfig } from './types.js';
import { AnthropicAdapter } from './anthropic.js';
import { CustomAnthropicAdapter } from './custom-anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { LLMError } from './errors.js';
import type { LLMProvider } from './types.js';

/**
 * Validate provider configuration before creating adapter.
 * Throws LLMError with descriptive message on invalid config.
 */
function validateProviderConfig(config: ProviderConfig): void {
  if (!config.apiKey?.trim()) {
    throw new LLMError(
      `ProviderConfig.apiKey is required (provider="${config.name || 'unknown'}")`,
      { provider: config.name, field: 'apiKey' }
    );
  }
  if (!config.model?.trim()) {
    throw new LLMError(
      `ProviderConfig.model is required (provider="${config.name || 'unknown'}")`,
      { provider: config.name, field: 'model' }
    );
  }
  if (!config.apiFormat) {
    throw new LLMError(
      `ProviderConfig.apiFormat is required (provider="${config.name || 'unknown'}")`,
      { provider: config.name, field: 'apiFormat' }
    );
  }
}

/**
 * Provider factory — creates appropriate adapter for config
 */
export function createLLMProvider(config: ProviderConfig): LLMProvider {
  // Validate configuration before instantiation
  validateProviderConfig(config);

  if (config.apiFormat === 'openai') return new OpenAIAdapter(config);
  if (config.apiFormat === 'gemini') return new GeminiAdapter(config);
  // anthropic format: Claude models use SDK (native API), others use raw fetch
  const isClaude = config.model.toLowerCase().includes('claude');
  return isClaude ? new AnthropicAdapter(config) : new CustomAnthropicAdapter(config);
}
