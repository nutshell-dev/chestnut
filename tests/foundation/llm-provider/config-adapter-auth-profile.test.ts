import { describe, it, expect } from 'vitest';
import { llmProviderConfigSchema, strictLLMProviderConfigSchema } from '../../../src/foundation/llm-provider/llm-provider-config-schema.js';
import { toProviderConfig } from '../../../src/foundation/llm-provider/config-adapter.js';

const base = {
  provider_id: 'custom:anthropic',
  api_format: 'anthropic',
  model: 'claude-test',
  base_url: 'https://example.test/anthropic',
};

describe('explicit authentication configuration', () => {
  it('raw reads retain ambient/oauth and strict writes require api_key credentials', () => {
    for (const authProfile of ['ambient', 'oauth']) {
      const parsed = llmProviderConfigSchema.parse({ ...base, auth_profile: authProfile });
      expect(parsed.api_key).toBeUndefined();
      expect(toProviderConfig(parsed).authProfile).toBe(authProfile);
    }
    expect(() => strictLLMProviderConfigSchema.parse({ ...base, auth_profile: 'api_key' }))
      .toThrow(/api_key/);
  });

  it('rejects an empty api_key and projects a non-empty key with its explicit profile', () => {
    expect(() => llmProviderConfigSchema.parse({ ...base, auth_profile: 'api_key', api_key: '' }))
      .toThrow(/api_key must not be empty/);
    const config = toProviderConfig(llmProviderConfigSchema.parse({
      ...base,
      auth_profile: 'api_key',
      api_key: 'sk-x',
    }));
    expect(config.apiKey).toBe('sk-x');
    expect(config.authProfile).toBe('api_key');
  });
});
