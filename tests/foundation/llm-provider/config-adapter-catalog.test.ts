/** Explicit schema → adapter → real pi-ai catalog resolution. */
import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-provider/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-provider/config-adapter.js';
import { llmProviderCatalog } from '../../../src/foundation/llm-provider/index.js';
const {
  UnknownCatalogProviderError,
  CatalogModelNotFoundError,
  CatalogProtocolMismatchError,
  deriveCatalogAuthProfile,
  catalogProvidersWithoutPreset,
} = llmProviderCatalog;
import { loadPiAiRuntime, resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-support.js';

function parseProvider(input: Record<string, unknown>) {
  return toProviderConfig(llmProviderConfigSchema.parse(input));
}

function catalogProvider(providerId: string, model: string, apiFormat: string) {
  return {
    provider_id: providerId,
    model,
    api_format: apiFormat,
    auth_profile: 'api_key',
    api_key: '${TEST_CATALOG_KEY}',
  };
}

describe('explicit catalog provider configuration', () => {
  it.each([
    { providerId: 'mistral', model: 'codestral-latest', apiFormat: 'mistral-conversations' },
    { providerId: 'azure', model: 'gpt-4', apiFormat: 'azure-openai-responses' },
  ])('$providerId resolves with explicit identity and protocol', async ({ providerId, model, apiFormat }) => {
    const config = parseProvider(catalogProvider(providerId, model, apiFormat));
    expect(config.piAiProvider).toBe(providerId);
    expect(config.model).toBe(model);
    expect(config.apiFormat).toBe(apiFormat);
    expect(config.authProfile).toBe('api_key');

    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(true);
    expect(resolved.model.provider).toBe(providerId);
  });

  it('OAuth-only provider uses explicit oauth profile without an api_key', async () => {
    const config = parseProvider({
      provider_id: 'openai-codex',
      model: 'gpt-6.1-sol',
      api_format: 'openai-codex-responses',
      auth_profile: 'oauth',
    });
    expect(config.authProfile).toBe('oauth');
    expect(config.apiKey).toBeUndefined();
    const runtime = await loadPiAiRuntime();
    expect(resolvePiAiModel(runtime, config).fromCatalog).toBe(true);
  });

  it('ambient provider uses explicit ambient profile and wire protocol', () => {
    const config = parseProvider({
      provider_id: 'amazon-bedrock',
      auth_profile: 'ambient',
      model: 'anthropic.claude-sonnet-4-6',
      api_format: 'bedrock-converse-stream',
    });
    expect(config.authProfile).toBe('ambient');
    expect(config.apiKey).toBeUndefined();
  });

  it('rejects incompatible auth profiles', () => {
    expect(() => parseProvider({
      provider_id: 'openai-codex',
      auth_profile: 'api_key',
      api_key: 'synthetic-key',
      model: 'gpt-6.1-sol',
      api_format: 'openai-codex-responses',
    })).toThrow(/OAuth-only/);
    expect(() => parseProvider(catalogProvider('mistral', 'codestral-latest', 'mistral-conversations')))
      .not.toThrow();
    expect(() => parseProvider({
      ...catalogProvider('mistral', 'codestral-latest', 'mistral-conversations'),
      auth_profile: 'oauth',
    })).toThrow(/no OAuth auth method/);
  });

  it('rejects a protocol inconsistent with the catalog provider', () => {
    expect(() => parseProvider(catalogProvider('mistral', 'codestral-latest', 'openai')))
      .toThrow(CatalogProtocolMismatchError);
    // Dynamic providers without a static protocol inventory cannot be validated.
    expect(() => parseProvider(catalogProvider('radius', 'balanced', 'openai')))
      .toThrow(CatalogProtocolMismatchError);
  });

  it('does not silently strip preset or accept missing explicit fields', () => {
    expect(() => llmProviderConfigSchema.parse({
      preset: 'anthropic',
      provider_id: 'anthropic',
      model: 'claude-haiku-4-5',
      api_format: 'anthropic',
      auth_profile: 'api_key',
      api_key: 'synthetic-key',
    })).toThrow(/preset/);
    expect(() => llmProviderConfigSchema.parse({ provider_id: 'mistral' })).toThrow();
    expect(() => llmProviderConfigSchema.parse({
      ...catalogProvider('mistral', 'codestral-latest', 'mistral-conversations'),
      api_key: undefined,
    })).toThrow(/api_key is required/);
  });

  it('rejects unknown providers and unknown catalog models with typed errors', () => {
    expect(() => parseProvider(catalogProvider('not-a-provider', 'x', 'openai')))
      .toThrow(UnknownCatalogProviderError);
    expect(() => parseProvider(catalogProvider('mistral', 'no-such-model', 'mistral-conversations')))
      .toThrow(CatalogModelNotFoundError);
  });

  it('rejects auto and bare environment variable names', () => {
    expect(() => llmProviderConfigSchema.parse(catalogProvider('mistral', 'auto', 'mistral-conversations')))
      .toThrow(/model must be explicit/);
    expect(() => parseProvider({
      ...catalogProvider('mistral', 'codestral-latest', 'mistral-conversations'),
      api_key: 'MISTRAL_API_KEY',
    })).toThrow(/bare environment variable name/);
  });
});

describe('explicit Moonshot catalog identity', () => {
  it('keeps CN identity and permits an explicit base_url override', async () => {
    const config = parseProvider({
      ...catalogProvider('moonshotai-cn', 'kimi-k2.6', 'openai'),
      base_url: 'https://proxy.example.com/v1',
    });
    const runtime = await loadPiAiRuntime();
    const expected = runtime.getBuiltinModels('moonshotai-cn').find(model => model.id === config.model);
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(true);
    expect(resolved.model).toEqual({ ...expected, baseUrl: 'https://proxy.example.com/v1' });
  });

  it('keeps the international provider as a separate explicit identity', async () => {
    const config = parseProvider(catalogProvider('moonshotai', 'kimi-k2.6', 'openai'));
    const runtime = await loadPiAiRuntime();
    expect(resolvePiAiModel(runtime, config).model.provider).toBe('moonshotai');
  });
});

describe('explicit metadata-only catalog hints', () => {
  it.each([
    { provider: 'deepseek', model: 'deepseek-flash[1m]', catalogModel: 'deepseek-flash', contextWindow: 1_000_000, baseUrl: 'https://api.deepseek.com/anthropic' },
    { provider: 'kimi-coding', model: 'k3-256k', catalogModel: 'k3-256k', contextWindow: 262_144, baseUrl: 'https://api.kimi.com/coding' },
    { provider: 'qwen-token-plan', model: 'qwen3.8-max', catalogModel: 'qwen3.8-max', contextWindow: 1_000_000, baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
    { provider: 'zai', model: 'glm-5.3', catalogModel: 'glm-5.3', contextWindow: 1_000_000, baseUrl: 'https://api.z.ai/api/anthropic' },
    { provider: 'minimax', model: 'MiniMax-M3.1-Flash', catalogModel: 'MiniMax-M3.1-Flash', contextWindow: 1_000_000, baseUrl: 'https://api.minimax.io/anthropic' },
  ])('$provider uses metadata without taking over the wire', async ({ provider, model, catalogModel, contextWindow, baseUrl }) => {
    const config = parseProvider({
      ...catalogProvider(provider, model, 'anthropic'),
      base_url: baseUrl,
      catalog_provider: provider,
      catalog_model: catalogModel,
    });
    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(false);
    expect(resolved.model.id).toBe(model);
    expect(resolved.model.api).toBe('anthropic-messages');
    expect(resolved.model.baseUrl).toBe(baseUrl);
    expect(resolved.model.contextWindow).toBe(contextWindow);
  });

  it('requires both hints and an explicit base URL', () => {
    const base = {
      ...catalogProvider('kimi-coding', 'k3-256k', 'anthropic'),
      base_url: 'https://api.kimi.com/coding',
      catalog_provider: 'kimi-coding',
      catalog_model: 'k3-256k',
    };
    expect(() => llmProviderConfigSchema.parse({ ...base, catalog_model: undefined })).toThrow(/provided together/);
    expect(() => parseProvider({ ...base, base_url: undefined })).toThrow(/require an explicit "base_url"/);
  });

  it('supports an explicit custom identity without catalog fallback', async () => {
    const config = parseProvider({
      provider_id: 'custom:anthropic',
      api_format: 'anthropic',
      auth_profile: 'api_key',
      api_key: '${TEST_META_KEY}',
      base_url: 'https://example.com/anthropic',
      model: 'some-unknown-model',
    });
    expect(config.catalogProvider).toBeUndefined();
    const runtime = await loadPiAiRuntime();
    const resolved = resolvePiAiModel(runtime, config);
    expect(resolved.fromCatalog).toBe(false);
    expect(resolved.model.api).toBe('anthropic-messages');
    expect(resolved.model.contextWindow).toBeGreaterThan(0);
  });
});

describe('catalog strategy', () => {
  it('retains auth facts for migration/UX without adapter defaults', () => {
    expect(deriveCatalogAuthProfile('openai-codex')).toBe('oauth');
    expect(deriveCatalogAuthProfile('mistral')).toBe('api_key');
  });

  it('lists catalog providers not covered by UX presets', () => {
    const uncovered = catalogProvidersWithoutPreset();
    expect(uncovered).toEqual(expect.arrayContaining(['mistral', 'azure', 'radius', 'moonshotai']));
    expect(uncovered).not.toEqual(expect.arrayContaining(['moonshotai-cn', 'anthropic', 'openai-codex']));
  });
});
