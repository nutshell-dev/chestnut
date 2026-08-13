import { describe, expect, it } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

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
});
