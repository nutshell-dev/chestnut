import type { ProviderConfig } from './types.js';
import { PiAiAdapter, type PiAiAdapterOptions } from './pi-ai-adapter.js';
import { LLMError } from './errors.js';
import type { LLMProvider } from './types.js';

/**
 * Validate provider configuration before creating adapter.
 * Throws LLMError with descriptive message on invalid config.
 */
function validateProviderConfig(config: ProviderConfig): void {
  // Phase 1926 Step D：apiKey 必填仅限 api_key profile；ambient（AWS 链/ADC/env）
  // 与 OAuth（stored credential）由 pi-ai 请求期 auth.resolve 裁决，缺失在请求期
  // loud 失败（LLMAuthError），不在装配期伪造 key。
  const profile = config.authProfile ?? 'api_key';
  if (profile === 'api_key' && !config.apiKey?.trim()) {
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
  // apiFormat 是自建 Model 路径的显式协议声明；catalog preset（piAiProvider）
  // 由 catalog model.api 裁决，不再要求伪协议字段。
  if (!config.apiFormat && !config.piAiProvider) {
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
 * 是自建 Model 路径的显式协议声明（不做 model/baseUrl 猜测路由）——catalog 命中
 *（piAiProvider + model 命中 catalog）时以 catalog model.api 为权威、不参与裁决，
 * 可省略（见 validateProviderConfig）。transport 字段保留于 schema（旧配置可读）
 * 但不再参与路由。
 */
export function createLLMProvider(config: ProviderConfig, options?: PiAiAdapterOptions): LLMProvider {
  validateProviderConfig(config);
  return new PiAiAdapter(config, options);
}
