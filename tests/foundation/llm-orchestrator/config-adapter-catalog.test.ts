/**
 * Phase 1927 Step D：显式 catalog provider 配置入口（provider_id + model + auth_profile）。
 *
 * 真实生产配置链：yaml schema parse → toProviderConfig → resolvePiAiModel catalog 命中
 * （真实 pi-ai runtime，不经任何内部 mock——反向三项第 1 条：不直构 ProviderConfig）。
 *
 * 覆盖：
 * - 无 preset 的 mistral / azure-openai-responses / radius（动态 provider 的显式
 *   model 规则 = 静态 seed 命中）全链路 catalog 命中；
 * - OAuth-only（openai-codex 显式 provider_id）派生 oauth profile；
 * - ambient 显式声明（amazon-bedrock）；
 * - provider_id/preset 互斥、未知 provider typed 拒绝、model 不在静态 seed typed
 *   拒绝、auth_profile 与 inventory auth 类不兼容 loud、model=auto 拒绝、
 *   bare env var 拒绝。
 */
import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-orchestrator/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-orchestrator/config-adapter.js';
import {
  UnknownCatalogProviderError,
  CatalogModelNotFoundError,
  deriveCatalogAuthProfile,
  catalogProvidersWithoutPreset,
} from '../../../src/foundation/llm-provider/index.js';
import { loadPiAiRuntime, resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-support.js';

function parseProvider(input: Record<string, unknown>) {
  return toProviderConfig(llmProviderConfigSchema.parse(input));
}

describe('显式 catalog provider 配置链（schema → adapter → runtime catalog 命中）', () => {
  it.each([
    { providerId: 'mistral', model: 'codestral-latest' },
    { providerId: 'azure-openai-responses', model: 'gpt-4' },
    // 动态 provider（radius）的显式 model 规则：静态 catalog seed 命中即合法配置
    { providerId: 'radius', model: 'balanced' },
  ])('$providerId：无 preset 全链路解析，runtime catalog 命中', async ({ providerId, model }) => {
    const config = parseProvider({
      provider_id: providerId,
      api_key: '${TEST_CATALOG_KEY}',
      model,
    });

    expect(config.piAiProvider).toBe(providerId);
    expect(config.model).toBe(model);
    // 显式 catalog 路径无自建 Model 回退
    expect(config.apiFormat).toBeUndefined();
    expect(config.authProfile).toBe('api_key');

    // 真实 pi-ai runtime：catalog 命中（不自建、不需要 baseUrl）
    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(true);
    expect(resolved.model.provider).toBe(providerId);
  });

  it('OAuth-only provider（openai-codex 显式 provider_id）：派生 oauth profile、无 api_key', async () => {
    const config = parseProvider({
      provider_id: 'openai-codex',
      model: 'gpt-5.5',
    });
    expect(config.authProfile).toBe('oauth');
    expect(config.apiKey).toBeUndefined();

    const runtime = await loadPiAiRuntime();
    expect(resolvePiAiModel(runtime, config).fromCatalog).toBe(true);
  });

  it('ambient 显式声明（amazon-bedrock auth_profile=ambient）', () => {
    const config = parseProvider({
      provider_id: 'amazon-bedrock',
      auth_profile: 'ambient',
      model: 'anthropic.claude-sonnet-4-6',
    });
    expect(config.authProfile).toBe('ambient');
    expect(config.apiKey).toBeUndefined();
  });

  it('auth_profile 与 inventory auth 类不兼容 → loud', () => {
    expect(() => parseProvider({
      provider_id: 'openai-codex',
      auth_profile: 'api_key',
      model: 'gpt-5.5',
    })).toThrow(/OAuth-only/);
    expect(() => parseProvider({
      provider_id: 'mistral',
      auth_profile: 'oauth',
      model: 'codestral-latest',
    })).toThrow(/no OAuth auth method/);
  });

  it('provider_id 与 preset 互斥 → loud', () => {
    expect(() => parseProvider({
      provider_id: 'mistral',
      preset: 'anthropic',
      model: 'codestral-latest',
    })).toThrow(/mutually exclusive/);
  });

  it('未知 provider_id → typed UnknownCatalogProviderError（available 清单为 inventory 单源）', () => {
    const err = (() => {
      try {
        parseProvider({ provider_id: 'not-a-provider', model: 'x' });
        return undefined;
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(UnknownCatalogProviderError);
    const typed = err as UnknownCatalogProviderError;
    expect(typed.providerId).toBe('not-a-provider');
    expect(typed.availableProviderIds).toContain('mistral');
  });

  it('model 不在静态 catalog seed → typed CatalogModelNotFoundError（不走自建回退）', () => {
    const err = (() => {
      try {
        parseProvider({ provider_id: 'mistral', model: 'no-such-model' });
        return undefined;
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(CatalogModelNotFoundError);
    expect((err as CatalogModelNotFoundError).model).toBe('no-such-model');
  });

  it('model 缺席或 auto → loud（显式 catalog 路径无 preset 默认）', () => {
    expect(() => parseProvider({ provider_id: 'mistral' })).toThrow(/requires an explicit "model"/);
    expect(() => parseProvider({ provider_id: 'mistral', model: 'auto' })).toThrow(/requires an explicit "model"/);
  });

  it('bare env var 名仍拒绝（与 preset 路径同纪律）', () => {
    expect(() => parseProvider({
      provider_id: 'mistral',
      api_key: 'MISTRAL_API_KEY',
      model: 'codestral-latest',
    })).toThrow(/bare environment variable name/);
  });
});

describe('catalog 配置策略单源', () => {
  it('deriveCatalogAuthProfile：OAuth-only → oauth，其余 → api_key', () => {
    expect(deriveCatalogAuthProfile('openai-codex')).toBe('oauth');
    expect(deriveCatalogAuthProfile('mistral')).toBe('api_key');
    expect(deriveCatalogAuthProfile('radius')).toBe('api_key');
  });

  it('catalogProvidersWithoutPreset：不含任何 preset 别名、含 mistral/azure/radius', () => {
    const uncovered = catalogProvidersWithoutPreset();
    expect(uncovered).toContain('mistral');
    expect(uncovered).toContain('azure-openai-responses');
    expect(uncovered).toContain('radius');
    // preset 已覆盖的不重复出现
    expect(uncovered).not.toContain('anthropic');
    expect(uncovered).not.toContain('openai-codex');
    expect(uncovered).not.toContain('amazon-bedrock');
  });
});
