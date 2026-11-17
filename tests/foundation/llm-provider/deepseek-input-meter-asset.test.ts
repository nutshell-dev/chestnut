import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenizerAsset = vi.hoisted(() => ({
  fail: false,
  encode: vi.fn((text: string) => ({ ids: [text] })),
}));

vi.mock('@huggingface/tokenizers', () => ({
  Tokenizer: class {
    constructor() {
      if (tokenizerAsset.fail) throw new Error('tokenizer asset unavailable');
    }

    encode(text: string): { ids: string[] } {
      return tokenizerAsset.encode(text);
    }
  },
}));

import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

/** Offline asset fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;

const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

beforeEach(() => {
  tokenizerAsset.fail = false;
  tokenizerAsset.encode.mockClear();
});

describe('DeepSeek V4.1 tokenizer assets and cache', () => {
  it('returns unavailable with the asset error and never reuses a count', async () => {
    tokenizerAsset.fail = true;
    const meter = await createLLMProvider(config).prepareInputMeter();
    const input = { messages: [{ role: 'user' as const, content: 'hello' }] };
    const first = meter.measure(input);
    const second = meter.measure(input);

    expect(first).toEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('tokenizer asset unavailable'),
    });
    expect(second).toEqual(first);
    expect(first).not.toMatchObject({ tokens: 0 });
  });

  it('evicts bounded cache entries instead of retaining every full input', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    const first = 'a'.repeat(9_000_000);
    const second = 'b'.repeat(9_000_000);
    const measure = (content: string): void => {
      expect(meter.measure({ messages: [{ role: 'user', content }] }).kind).toBe('counted');
    };

    measure(first);
    measure(second);
    expect(tokenizerAsset.encode).toHaveBeenCalledTimes(2);
    measure(first);
    expect(tokenizerAsset.encode).toHaveBeenCalledTimes(3);
  });
});
