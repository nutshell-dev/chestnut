import { describe, expect, it } from 'vitest';
import {
  legacyProviderIdentity,
  providerCacheKey,
  providerIdentity,
} from '../../../src/foundation/llm-orchestrator/provider-identity.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

function config(patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'primary',
    apiFormat: 'anthropic',
    model: 'model-a',
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret-key',
    temperature: 0,
    timeoutMs: 1_000,
    ...patch,
  };
}

describe('Phase 2027 provider identity', () => {
  it('无扩展语义及显式 api_key 保持旧身份算法', () => {
    const base = config();
    expect(providerIdentity(base)).toBe(legacyProviderIdentity(base));
    expect(providerIdentity(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(providerIdentity(config({ authProfile: 'api_key' })))
      .toBe(legacyProviderIdentity(base));
  });

  it.each([
    ['authProfile', { authProfile: 'oauth' as const }],
    ['piAiProvider', { piAiProvider: 'catalog-a' }],
    ['catalogProvider', { catalogProvider: 'metadata-a' }],
    ['catalogModel', { catalogModel: 'metadata-model-a' }],
  ])('%s 扩展字段参与故障身份', (_field, patch) => {
    const extended = config(patch);
    expect(providerIdentity(extended)).not.toBe(providerIdentity(config()));
    expect(providerIdentity(extended)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('四个扩展字段各自变化都会产生不同身份与 cache key', () => {
    const variants: Array<Partial<ProviderConfig>> = [
      { authProfile: 'ambient' },
      { piAiProvider: 'catalog-b' },
      { catalogProvider: 'metadata-b' },
      { catalogModel: 'metadata-model-b' },
    ];
    const baseExtended = config({
      authProfile: 'oauth',
      piAiProvider: 'catalog-a',
      catalogProvider: 'metadata-a',
      catalogModel: 'metadata-model-a',
    });
    for (const patch of variants) {
      const changed = config({ ...baseExtended, ...patch });
      expect(providerIdentity(changed)).not.toBe(providerIdentity(baseExtended));
      expect(providerCacheKey(changed, 'audit-a'))
        .not.toBe(providerCacheKey(baseExtended, 'audit-a'));
    }
  });

  it('行为参数只改变 cache 指纹，不改变故障身份', () => {
    const base = config();
    const changed = config({ temperature: 1, timeoutMs: 2_000, maxTokens: 128 });
    expect(providerIdentity(changed)).toBe(providerIdentity(base));
    expect(providerCacheKey(changed, 'audit-a')).not.toBe(providerCacheKey(base, 'audit-a'));
    expect(providerCacheKey(base, 'audit-b')).not.toBe(providerCacheKey(base, 'audit-a'));
  });

  it('身份与 cache key 不泄露明文 API key', () => {
    const value = config();
    expect(providerIdentity(value)).not.toContain(value.apiKey!);
    expect(providerCacheKey(value, 'audit-a')).not.toContain(value.apiKey!);
  });
});
