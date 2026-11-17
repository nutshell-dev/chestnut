import { describe, expect, it } from 'vitest';
import {
  legacyProviderIdentity,
  providerCacheKey,
  providerIdentity,
} from '../../../src/foundation/llm-orchestrator/provider-identity.js';
import { connection, type ProviderConnection } from './provider-test-fixtures.js';
import { describeProviderConnection } from '../../../src/foundation/llm-provider/provider-connection.js';

/** Behavior-fingerprint fixtures; distinct values are intentional, not defaults. */
const PROVIDER_TIMEOUT_FIXTURE_MS = 1_000;
const CHANGED_PROVIDER_TIMEOUT_FIXTURE_MS = 2_000;

function config(patch: Partial<ProviderConnection> = {}) {
  return describeProviderConnection(connection('primary', {
    model: 'model-a',
    baseUrl: 'https://example.test/v1',
    authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'key-revision-a' },
    defaults: { temperature: 0, timeoutMs: PROVIDER_TIMEOUT_FIXTURE_MS },
    ...patch,
  }));
}

describe('Phase 2027 provider identity', () => {
  it('无扩展语义及显式 api_key 保持旧身份算法', () => {
    const base = config();
    expect(providerIdentity(base)).toBe(legacyProviderIdentity(base));
    expect(providerIdentity(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(providerIdentity(config({
      authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'key-revision-a', profile: 'api_key' },
    }))).toBe(legacyProviderIdentity(base));
  });

  it.each([
    ['authentication.profile', { authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'key-revision-a', profile: 'oauth' as const } }],
    ['authentication.identity', { authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'account-a' } }],
    ['providerId', { providerId: 'metadata-a' }],
    ['baseUrl', { baseUrl: 'https://metadata.example.test/v1' }],
  ])('%s 连接身份字段参与故障身份', (_field, patch) => {
    const extended = config(patch);
    expect(providerIdentity(extended)).not.toBe(providerIdentity(config()));
    expect(providerIdentity(extended)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('四个连接身份字段各自变化都会产生不同身份与 cache key', () => {
    const variants: Array<Partial<ProviderConnection>> = [
      { authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'account-a', profile: 'ambient' } },
      { authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'other-b', profile: 'oauth' } },
      { providerId: 'metadata-b' },
      { baseUrl: 'https://metadata-b.example.test/v1' },
    ];
    const baseExtended = config({
      authentication: { kind: 'api_key' as const, value: 'secret-key', identity: 'account-a', profile: 'oauth' },
      providerId: 'metadata-a',
      baseUrl: 'https://metadata-a.example.test/v1',
    });
    for (const patch of variants) {
      const changed = config({ ...baseExtended, ...patch });
      expect(providerIdentity(changed)).not.toBe(providerIdentity(baseExtended));
      expect(providerCacheKey(changed)).not.toBe(providerCacheKey(baseExtended));
    }
  });

  it('行为参数只改变 cache 指纹，不改变故障身份', () => {
    const base = config();
    const changed = config({
      defaults: { temperature: 1, timeoutMs: CHANGED_PROVIDER_TIMEOUT_FIXTURE_MS, maxTokens: 128 },
    });
    expect(providerIdentity(changed)).toBe(providerIdentity(base));
    expect(providerCacheKey(changed)).not.toBe(providerCacheKey(base));
    expect(providerCacheKey(base)).toBe(providerCacheKey(config()));
  });

  it('认证身份轮换改变 operational fault/cache 身份，不依赖明文 secret', () => {
    const first = config({ authentication: { kind: 'api_key' as const, value: 'secret-before', identity: 'before-revision' } });
    const rotated = config({ authentication: { kind: 'api_key' as const, value: 'secret-after', identity: 'after-revision' } });
    expect(providerIdentity(rotated)).not.toBe(providerIdentity(first));
    expect(providerCacheKey(rotated)).not.toBe(providerCacheKey(first));
  });

  it('身份与 cache key 不泄露明文 API key', () => {
    const value = config();
    expect(providerIdentity(value)).not.toContain('secret-key');
    expect(providerCacheKey(value)).not.toContain('secret-key');
  });
});
