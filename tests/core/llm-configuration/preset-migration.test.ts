import { describe, expect, it } from 'vitest';
import {
  LegacyPresetMigrationError,
  migrateLegacyLLMConfig,
  migrateLegacyProviderConfig,
} from '../../../src/core/llm-configuration/index.js';

describe('legacy preset migration capability', () => {
  it('materializes identity, protocol, endpoint, auth, and thinking defaults explicitly', () => {
    const migrated = migrateLegacyProviderConfig({
      preset: 'anthropic',
      model: 'claude-haiku-4-5',
      api_key: '${ANTHROPIC_API_KEY}',
    });
    expect(migrated).toMatchObject({
      provider_id: 'anthropic',
      api_format: 'anthropic',
      model: 'claude-haiku-4-5',
      base_url: 'https://api.anthropic.com',
      auth_profile: 'api_key',
      api_key: '${ANTHROPIC_API_KEY}',
      thinking_mode: 'adaptive',
      thinking_effort: 'max',
    });
    expect(migrated).not.toHaveProperty('preset');
  });

  it('uses the legacy effective catalog protocol rather than the custom alias', () => {
    expect(migrateLegacyProviderConfig({
      preset: 'openai',
      model: 'gpt-4o',
      api_key: '${OPENAI_API_KEY}',
    })).toMatchObject({ provider_id: 'openai', api_format: 'openai-responses' });
    expect(migrateLegacyProviderConfig({
      preset: 'amazon-bedrock',
      model: 'anthropic.claude-sonnet-4-6',
    })).toMatchObject({
      provider_id: 'amazon-bedrock',
      api_format: 'bedrock-converse-stream',
      auth_profile: 'ambient',
    });
  });

  it('preserves metadata-only behavior with explicit paired hints', () => {
    const migrated = migrateLegacyProviderConfig({
      preset: 'deepseek',
      api_key: '${DEEPSEEK_API_KEY}',
    });
    expect(migrated).toMatchObject({
      provider_id: 'deepseek',
      api_format: 'anthropic',
      model: 'deepseek-flash[1m]',
      base_url: 'https://api.deepseek.com/anthropic',
      catalog_provider: 'deepseek',
      catalog_model: 'deepseek-flash',
      thinking: true,
      thinking_effort: 'max',
    });
  });

  it('maps legacy non-catalog models to explicit custom identities', () => {
    expect(migrateLegacyProviderConfig({
      preset: 'anthropic',
      model: 'claude-legacy',
      api_key: 'sk-test',
    })).toMatchObject({
      provider_id: 'custom:anthropic',
      api_format: 'anthropic',
      model: 'claude-legacy',
      base_url: 'https://api.anthropic.com',
    });
  });

  it('migrates primary and fallbacks without mutating the source', () => {
    const source = {
      primary: { preset: 'openai', model: 'gpt-4o', api_key: '${PRIMARY_KEY}' },
      fallbacks: [{ preset: 'custom-gemini', model: 'gemini-custom', base_url: 'https://example.test', api_key: '${FALLBACK_KEY}' }],
    };
    const result = migrateLegacyLLMConfig(source);
    expect(result.migrated).toBe(true);
    expect(result.config.primary.provider_id).toBe('openai');
    expect(result.config.fallbacks?.[0]?.provider_id).toBe('custom:custom-gemini');
    expect(source.primary).toHaveProperty('preset', 'openai');
  });

  it('strips historical transport fields before strict schema validation', () => {
    const result = migrateLegacyLLMConfig({
      primary: {
        preset: 'anthropic',
        model: 'claude-legacy',
        api_key: '${PRIMARY_KEY}',
        transport: 'legacy-wire-transport',
      },
      fallbacks: [{
        provider_id: 'custom:openai',
        api_format: 'openai',
        auth_profile: 'api_key',
        api_key: '${FALLBACK_KEY}',
        model: 'model',
        base_url: 'https://example.test/v1',
        transport: 'legacy-wire-transport',
      }],
    });

    expect(result.migrated).toBe(true);
    expect(result.config.primary).not.toHaveProperty('transport');
    expect(result.config.fallbacks?.[0]).not.toHaveProperty('transport');
  });

  it('returns an already explicit document unchanged', () => {
    const source = {
      primary: {
        provider_id: 'custom:openai',
        api_format: 'openai',
        auth_profile: 'api_key',
        api_key: '${PRIMARY_KEY}',
        model: 'model',
        base_url: 'https://example.test/v1',
      },
    };
    const result = migrateLegacyLLMConfig(source);
    expect(result.migrated).toBe(false);
    expect(result.config.primary).toBe(source.primary);
  });

  it('fails closed with typed errors for unknown or incomplete presets', () => {
    for (const [source, code] of [
      [{ preset: 'not-a-preset', api_key: 'sk-not-in-error' }, 'unknown_preset'],
      [{ preset: 'custom-openai', model: 'model', api_key: 'sk-not-in-error' }, 'incomplete_mapping'],
      [{
        provider_id: 'azure', auth_profile: 'api_key', model: 'gpt-4o', api_key: 'sk-not-in-error',
      }, 'incomplete_mapping'],
    ] as const) {
      let error: unknown;
      try { migrateLegacyProviderConfig(source); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(LegacyPresetMigrationError);
      expect((error as LegacyPresetMigrationError).code).toBe(code);
      expect((error as Error).message).not.toContain('sk-not-in-error');
    }
  });
});
