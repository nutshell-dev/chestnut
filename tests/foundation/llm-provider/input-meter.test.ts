import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMProvider, type ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: 1000,
};
afterEach(() => vi.unstubAllGlobals());

describe('resolved model input meter', () => {
  it('keeps the wire alias and uses its resolved 1M window without network', async () => {
    const fetch = vi.fn(() => { throw new Error('network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    const meter = await createLLMProvider(config).prepareInputMeter();
    expect(meter.descriptor.model).toBe('deepseek-flash[1m]');
    expect(meter.descriptor.contextWindow).toBe(1_000_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('revisions follow counting options but never include credentials', async () => {
    const first = await createLLMProvider(config).prepareInputMeter();
    const otherKey = await createLLMProvider({ ...config, apiKey: 'different-secret' }).prepareInputMeter();
    const otherThinking = await createLLMProvider({ ...config, thinking: true }).prepareInputMeter();
    expect(otherKey.descriptor.revision).toBe(first.descriptor.revision);
    expect(otherThinking.descriptor.revision).not.toBe(first.descriptor.revision);
    expect(JSON.stringify(otherKey.descriptor)).not.toContain('different-secret');
  });

  it('labels unknown models as estimates', async () => {
    const meter = await createLLMProvider({ ...config, catalogProvider: undefined,
      catalogModel: undefined, model: 'unknown-model' }).prepareInputMeter();
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
      kind: 'estimated', method: 'legacy-cl100k', reason: 'unsupported_model_or_protocol',
    });
  });

  it('accepts successful input above the old 256K fallback, below the resolved window', async () => {
    const events = [
      { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage: { input_tokens: 256049, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map(e =>
      `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })));
    const result = await createLLMProvider(config).call({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
