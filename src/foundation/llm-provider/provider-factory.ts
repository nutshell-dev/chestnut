import type { ProviderConfig } from './types.js';
import { PiAiAdapter } from './pi-ai-adapter.js';
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
 * Provider factory — Phase 1925 Step C：pi-ai 是唯一 L1 provider 实现。
 *
 * 不再按 apiFormat/transport 路由旧手写适配器（已随 Step D 删除）；apiFormat
 * 仍必填——它是 pi-ai api 的显式协议声明（不做 model/baseUrl 猜测路由）。
 * transport 字段保留于 schema（旧配置可读）但不再参与路由。
 */
export function createLLMProvider(config: ProviderConfig): LLMProvider {
  validateProviderConfig(config);
  return new PiAiAdapter(config);
}
