import { describe, expect, it } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-provider/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-provider/config-adapter.js';
import { llmProviderCatalog } from '../../../src/foundation/llm-provider/index.js';
const { CATALOG_REVISION, resolveCatalogIdentity } = llmProviderCatalog;
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

/** Offline custom-provider fixture only needs a short, positive timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;

function parseProvider(input: Record<string, unknown>): ProviderConfig {
  return toProviderConfig(llmProviderConfigSchema.parse(input));
}

describe('catalog identity facade', () => {
  it('resolves explicit provider identity with source, revision and catalog window', () => {
    const resolution = parseProvider({
      provider_id: 'openai', model: 'gpt-5', api_format: 'openai-responses', auth_profile: 'api_key', api_key: 'secret-not-in-resolution',
    }).catalogResolution;
    expect(resolution).toMatchObject({
      kind: 'catalog_model', source: 'provider_id', providerId: 'openai', modelId: 'gpt-5',
      revision: CATALOG_REVISION,
      window: { contextWindow: 400_000, source: 'catalog', revision: CATALOG_REVISION },
    });
    expect(JSON.stringify(resolution)).not.toContain('secret-not-in-resolution');
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution?.window)).toBe(true);
  });

  it('resolves an explicit aliased provider without a preset source', () => {
    const resolution = parseProvider({
      provider_id: 'moonshotai-cn', model: 'kimi-k2.6', api_format: 'openai', auth_profile: 'api_key', api_key: 'synthetic-key',
    }).catalogResolution;
    expect(resolution).toMatchObject({
      kind: 'catalog_model', source: 'provider_id', providerId: 'moonshotai-cn', modelId: 'kimi-k2.6',
    });
  });

  it('keeps metadata-only catalog identity separate from wire identity', () => {
    const resolution = parseProvider({
      provider_id: 'deepseek', api_format: 'anthropic', auth_profile: 'api_key', api_key: 'synthetic-key',
      model: 'deepseek-flash[1m]', base_url: 'https://api.deepseek.com/anthropic',
      catalog_provider: 'deepseek', catalog_model: 'deepseek-flash',
    }).catalogResolution;
    expect(resolution).toMatchObject({
      kind: 'metadata_only', source: 'metadata_only', providerId: 'deepseek', modelId: 'deepseek-flash',
      wire: { model: 'deepseek-flash[1m]', api: 'anthropic-messages' },
      window: { contextWindow: 1_000_000, source: 'catalog' },
    });
  });

  it('keeps explicit custom and unresolved duplicate fallback observable', () => {
    const config: ProviderConfig = {
      name: 'custom', model: 'gpt-5', apiFormat: 'openai', baseUrl: 'https://example.test/v1',
      temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
    };
    const resolution = resolveCatalogIdentity(config);
    expect(resolution).toMatchObject({
      kind: 'custom', source: 'explicit_custom', modelId: 'gpt-5',
      window: { contextWindow: 128_000, source: 'explicit_fallback' },
    });
  });

  it('uses provider-qualified duplicate resolution instead of another provider window', () => {
    const resolution = parseProvider({
      provider_id: 'cloudflare-ai-gateway', model: 'gpt-5', api_format: 'openai-responses', auth_profile: 'api_key', api_key: 'synthetic-key',
    }).catalogResolution;
    expect(resolution?.window).toMatchObject({ contextWindow: 128_000, source: 'catalog' });
    expect(resolution?.providerId).toBe('cloudflare-ai-gateway');
  });
});
