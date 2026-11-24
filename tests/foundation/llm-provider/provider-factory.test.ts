import { describe, expect, it } from 'vitest';
import {
  createLLMProvider,
  createProviderFromConnection,
  createProviderFromInput,
} from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import { toProviderConfig } from '../../../src/foundation/llm-provider/config-adapter.js';
import {
  providerConnectionFromResolvedConfig,
  providerInputFromResolvedConfig,
} from '../../../src/foundation/llm-provider/provider-connection.js';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-provider/llm-provider-config-schema.js';
import { TEST_LLM_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

describe('createLLMProvider config boundary', () => {
  it('does not accept a prebuilt provider through duck-typed config', () => {
    const duckProvider = {
      name: 'duck-provider',
      model: 'duck-model',
      async *stream() {},
    };

    expect(() => createLLMProvider(duckProvider as unknown as ProviderConfig))
      .toThrow('ProviderConfig.apiKey is required');
  });

  describe('createProviderFromConnection', () => {
    it('creates the same L1 adapter from a neutral api-key connection', () => {
      const provider = createProviderFromConnection({
        providerId: 'neutral',
        model: 'test-model',
        baseUrl: 'https://api.test.invalid/v1',
        apiFormat: 'openai',
        authentication: { kind: 'api_key', value: 'secret' },
        defaults: { temperature: 0.2, timeoutMs: TEST_LLM_TIMEOUT_MS, maxTokens: 99 },
      });
      expect(provider).toMatchObject({ name: 'neutral', model: 'test-model' });
    });

    it('retains the private L1 catalog projection across the neutral boundary', () => {
      const config = toProviderConfig(llmProviderConfigSchema.parse({
        provider_id: 'custom:anthropic',
        api_format: 'anthropic',
        auth_profile: 'api_key',
        api_key: 'secret',
        model: 'claude-test',
        base_url: 'https://api.test.invalid/anthropic',
      }));
      const connection = providerConnectionFromResolvedConfig(config);
      const provider = createProviderFromConnection(connection);
      expect(provider).toMatchObject({ name: config.name, model: config.model });
      expect(connection).not.toHaveProperty('catalogProvider');
      expect(connection).not.toHaveProperty('catalogResolution');
    });
  });

  describe('createProviderFromInput', () => {
    it('creates the equivalent adapter and an opaque descriptor from public input', () => {
      const config = toProviderConfig(llmProviderConfigSchema.parse({
        provider_id: 'custom:anthropic',
        api_format: 'anthropic',
        auth_profile: 'api_key',
        api_key: 'secret',
        model: 'claude-test',
        base_url: 'https://api.test.invalid/anthropic',
      }));
      const input = providerInputFromResolvedConfig(config);
      const legacy = createProviderFromConnection(providerConnectionFromResolvedConfig(config));
      const handle = createProviderFromInput(input);

      expect(handle.provider).toMatchObject({ name: 'api.test.invalid', model: legacy.model });
      expect(handle.descriptor).toMatchObject({ providerId: 'api.test.invalid', model: config.model });
      expect(handle.descriptor.identity).toMatch(/^[0-9a-f]{12}$/);
    });
  });
});
