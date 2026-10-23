/**
 * Phase 1927 Step D：显式 catalog provider 配置入口（provider_id + model + auth_profile）。
 *
 * 真实生产配置链：yaml schema parse → toProviderConfig → resolvePiAiModel catalog 命中
 * （真实 pi-ai runtime，不经任何内部 mock——反向三项第 1 条：不直构 ProviderConfig）。
 *
 * 覆盖：
 * - 无 preset 的 mistral / azure（pi-ai 1.4.0 起 azure-openai-responses 只是 api、
 *   provider 归并为 azure）/ radius（动态 provider 的显式 model 规则 = 静态 seed 命中）
 *   全链路 catalog 命中；
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
    // pi-ai 1.4.0：azure-openai-responses 仅是 api；provider 为 azure（模型 api 同前）
    { providerId: 'azure', model: 'gpt-4' },
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
      model: 'gpt-6.1-sol',
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
      model: 'gpt-6.1-sol',
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

describe('Phase 1975 Step C：五家 curated preset 的 metadata-only catalog 解析', () => {
  // 断言四元组：fromCatalog=false、model.id=实际 wire model、api=anthropic-messages、
  // baseUrl=curated；contextWindow 取自 pi-ai 1.4.0 catalog 元数据。
  it.each([
    { preset: 'deepseek', model: 'deepseek-flash[1m]', contextWindow: 1_000_000, baseUrl: 'https://api.deepseek.com/anthropic' },
    { preset: 'kimi', model: 'k3-256k', contextWindow: 262_144, baseUrl: 'https://api.kimi.com/coding' },
    { preset: 'qwen', model: 'qwen3.8-max', contextWindow: 1_000_000, baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
    { preset: 'zai', model: 'glm-5.3', contextWindow: 1_000_000, baseUrl: 'https://api.z.ai/api/anthropic' },
    { preset: 'minimax', model: 'MiniMax-M3.1-Flash', contextWindow: 1_000_000, baseUrl: 'https://api.minimax.io/anthropic' },
  ])('$preset：catalog 只供元数据，wire 保持 Anthropic preset', async ({ preset, model, contextWindow, baseUrl }) => {
    const config = parseProvider({ preset, api_key: '${TEST_META_KEY}' });
    expect(config.catalogProvider).toBeDefined();
    expect(config.catalogModel).toBeDefined();

    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(false);
    expect(resolved.model.id).toBe(model); // 实际 wire model，不是 catalogModel
    expect(resolved.model.api).toBe('anthropic-messages');
    expect(resolved.model.baseUrl).toBe(baseUrl);
    expect(resolved.model.contextWindow).toBe(contextWindow);
  });

  it('Kimi：1.4.0 catalog 的 kimi-coding 是 openai-completions，metadata-only 后 wire 仍是 anthropic', async () => {
    const runtime = await loadPiAiRuntime();
    // 实然证据：1.4.0 catalog 协议漂移（若上游改回 anthropic 此断言需复核）
    const catalogHit = runtime.getBuiltinModels('kimi-coding').find((m) => m.id === 'k3-256k');
    expect(catalogHit?.api).toBe('openai-completions');

    const config = parseProvider({ preset: 'kimi', api_key: '${TEST_META_KEY}' });
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.model.api).toBe('anthropic-messages');
    expect(resolved.model.baseUrl).toBe('https://api.kimi.com/coding');
  });

  it('DeepSeek：model.id 保留 [1m]（不被 catalogModel 替换）', async () => {
    const config = parseProvider({ preset: 'deepseek', api_key: '${TEST_META_KEY}' });
    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.model.id).toBe('deepseek-flash[1m]');
    expect(resolved.model.contextWindow).toBe(1_000_000); // 来自 deepseek/deepseek-flash 元数据
  });

  it('setup 写入的显式 base_url 覆盖 preset 默认（候选胜出端点优先）', async () => {
    const config = parseProvider({
      preset: 'minimax',
      api_key: '${TEST_META_KEY}',
      base_url: 'https://api.minimax.cn/anthropic',
    });
    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.model.baseUrl).toBe('https://api.minimax.cn/anthropic');
    expect(resolved.model.contextWindow).toBe(1_000_000);
    expect(resolved.fromCatalog).toBe(false);
  });

  it('catalogProvider/catalogModel 缺失的 preset（custom-anthropic）仍走 heuristic fallback', async () => {
    const config = parseProvider({
      preset: 'custom-anthropic',
      api_key: '${TEST_META_KEY}',
      base_url: 'https://example.com/anthropic',
      model: 'some-unknown-model',
    });
    expect(config.catalogProvider).toBeUndefined();
    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(false);
    expect(resolved.model.api).toBe('anthropic-messages');
    expect(resolved.model.contextWindow).toBeGreaterThan(0); // heuristic 回落，不抛错
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
    // pi-ai 1.4.0：azure-openai-responses 只是 api，不再是 provider
    expect(uncovered).toContain('azure');
    expect(uncovered).toContain('radius');
    // preset 已覆盖的不重复出现
    expect(uncovered).not.toContain('anthropic');
    expect(uncovered).not.toContain('openai-codex');
    expect(uncovered).not.toContain('amazon-bedrock');
  });
});
