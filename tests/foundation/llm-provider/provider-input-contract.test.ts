import { describe, expect, it } from 'vitest';
import {
  createProviderFromInput,
} from '../../../src/foundation/llm-provider/provider-factory.js';
import {
  providerInputFromResolvedConfig,
  type ProviderInput,
} from '../../../src/foundation/llm-provider/provider-connection.js';
import { toProviderConfig } from '../../../src/foundation/llm-provider/config-adapter.js';
import { llmProviderConfigSchema } from '../../../src/foundation/llm-provider/llm-provider-config-schema.js';

const input: ProviderInput = {
  baseUrl: 'https://api.test.invalid/v1',
  model: 'model',
  protocol: 'openai',
  authentication: { kind: 'api_key', value: 'secret', identity: 'revision-a' },
};

describe('ProviderInput contract', () => {
  it('contains neither catalog/store/default projection nor orchestration state', () => {
    expect(Object.keys(input).sort()).toEqual([
      'authentication',
      'baseUrl',
      'model',
      'protocol',
    ]);
    expect(input).not.toHaveProperty('providerId');
    expect(input).not.toHaveProperty('defaults');
    expect(input).not.toHaveProperty('credentialStore');
    expect(input).not.toHaveProperty('catalogResolution');
    expect(input).not.toHaveProperty('recoveryState');
  });

  it('rejects forbidden fields at compile time', () => {
    // @ts-expect-error catalog entries stay behind the L1 setup resolver
    const withCatalog: ProviderInput = { ...input, catalogProvider: 'anthropic' };
    // @ts-expect-error credential backends are assembly-private
    const withStore: ProviderInput = { ...input, credentialStore: {} };
    // @ts-expect-error defaults remain an L1 private projection
    const withDefaults: ProviderInput = { ...input, defaults: { temperature: 0 } };
    expect(withCatalog).toBeDefined();
    expect(withStore).toBeDefined();
    expect(withDefaults).toBeDefined();
  });

  it('returns a secret-safe descriptor from value-only input', () => {
    const config = toProviderConfig(llmProviderConfigSchema.parse({
      provider_id: 'custom:anthropic',
      api_format: 'anthropic',
      auth_profile: 'api_key',
      api_key: 'secret',
      base_url: 'https://api.test.invalid/anthropic',
      model: 'model',
    }));
    const resolvedInput = providerInputFromResolvedConfig(config);
    const handle = createProviderFromInput(resolvedInput);

    expect(handle.provider).toMatchObject({ name: 'api.test.invalid', model: config.model });
    expect(handle.descriptor.providerId).toBe('api.test.invalid');
    expect(handle.descriptor.model).toBe(config.model);
    expect(JSON.stringify(handle.descriptor)).not.toContain('"secret"');
    expect(resolvedInput).not.toHaveProperty('catalogProvider');
    expect(resolvedInput).not.toHaveProperty('catalogResolution');
    expect(resolvedInput).not.toHaveProperty('defaults');
  });

  it('rebuilds equivalent descriptors from copies and separates recovery from key rotation', () => {
    const first = createProviderFromInput(input).descriptor;
    const copied = createProviderFromInput({ ...input, authentication: { ...input.authentication } }).descriptor;
    const rotated = createProviderFromInput({
      ...input,
      authentication: { ...input.authentication, value: 'next-secret', identity: 'revision-b' },
    }).descriptor;
    expect(copied).toEqual(first);
    expect(rotated.identity).toBe(first.identity);
    expect(rotated.stableIdentity).toBe(first.stableIdentity);
    expect(rotated.cacheKey).not.toBe(first.cacheKey);
    expect(JSON.stringify(rotated)).not.toContain('next-secret');
  });
});
