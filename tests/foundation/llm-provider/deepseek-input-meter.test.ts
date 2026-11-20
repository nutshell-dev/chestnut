import { describe, expect, it } from 'vitest';
import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerSpec from '../../../src/foundation/llm-provider/tokenizers/deepseek-v41.tokenizer.json' with { type: 'json' };
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';

/** Offline meter fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

function referenceText(text: string): number {
  if (!text) return 0;
  const encoder = new Tokenizer({ ...tokenizerSpec, added_tokens: [] }, {});
  return encoder.encode(text, { add_special_tokens: false }).ids.length;
}

describe('DeepSeek V4.1 input meter', () => {
  it('estimates only input content without reconstructing the provider template', async () => {
    const meter = await createLLMProvider({ ...config, thinking: true }).prepareInputMeter();
    expect(meter.capability).toEqual({ kind: 'complete_only' });
    expect('project' in meter).toBe(false);
    expect(meter.measure({
      system: 'You are helpful.', messages: [{ role: 'user', content: 'hello' }], tools: [],
    })).toEqual({
      kind: 'estimated', method: 'deepseek-v41-text', reason: 'context_trim_only:deepseek_v41_text',
      tokens: referenceText('You are helpful.') + referenceText('hello'),
    });
  });

  it('returns unavailable for special-token-looking text instead of interpreting wire syntax', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    expect(meter.measure({ messages: [{ role: 'user', content: '<think>ordinary</think>' }] })).toEqual({
      kind: 'unavailable', reason: 'deepseek_v41_text_estimate_unavailable:control_token_in_text:<think>',
    });
  });

  it('coarsely estimates declared tool fields without reconstructing wire markup', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    expect(meter.measure({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'server', description: '', input_schema: { type: 'object' } }],
    })).toEqual({
      kind: 'estimated', method: 'deepseek-v41-text', reason: 'context_trim_only:deepseek_v41_text',
      tokens: referenceText('hello') + referenceText('server') + referenceText('{"type":"object"}'),
    });
  });

  it('returns unavailable rather than estimating unsupported multimodal content', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    expect(meter.measure({
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ] }],
    })).toEqual({ kind: 'unavailable', reason: 'deepseek_v41_text_estimate_unavailable:non_text_content' });
  });
});
