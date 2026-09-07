import type { ProviderConfig } from './types.js';
import { AnthropicAdapter } from './anthropic.js';
import { CustomAnthropicAdapter } from './custom-anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { LLMError } from './errors.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from './audit-events.js';
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
  // phase 1797: anthropic format transport 由显式 discriminator 决定（model 名不参与路由）。
  // 缺失 = 迁移默认 'fetch' + 可审计（旧 heuristic model.includes('claude') 已拆除）。
  if (config.transport === undefined) {
    config.auditLog?.write(
      LLM_PROVIDER_AUDIT_EVENTS.TRANSPORT_DEFAULTED,
      `provider=${config.name}`,
      'transport=fetch',
    );
  }
  return (config.transport ?? 'fetch') === 'sdk' ? new AnthropicAdapter(config) : new CustomAnthropicAdapter(config);
}
