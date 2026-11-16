import { describe, expect, it } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
const { createLLMProvider } = llmProviderCall;
import type { llmProviderConfigContract } from '../../../src/foundation/llm-provider/index.js';
type ProviderConfig = llmProviderConfigContract.ProviderConfig;


/** Offline meter fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;

const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

describe('DeepSeek V4.1 input meter', () => {
  it('matches the official renderer for system + user input', async () => {
    const meter = await createLLMProvider({ ...config, thinking: true }).prepareInputMeter();
    expect(meter.capability).toEqual({ kind: 'complete_only' });
    expect(meter.measure({ system: 'You are helpful.', messages: [{ role: 'user', content: 'hello' }], tools: [] })).toEqual({
      kind: 'counted', tokens: 35, method: 'deepseek-v41-template',
    });
  });

  it('does not treat special-token-looking ordinary text as a special token', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    const result = meter.measure({ messages: [{ role: 'user', content: '<think>ordinary</think>' }] });
    expect(result.kind).toBe('counted');
    expect(result).not.toEqual({ kind: 'counted', tokens: 5, method: 'deepseek-v41-template' });
  });

  it('returns unavailable for unsupported server/deferred tools', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    const measurement = meter.measure({ messages: [{ role: 'user', content: 'hello' }], tools: [{
      name: 'server', description: '', input_schema: { type: 'object' },
      type: 'computer_20250101',
    } as never] });
    expect(measurement).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/^deepseek_v41_projection_failed:/),
    });
  });

  it('returns unavailable rather than estimating unsupported multimodal projection', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
    const measurement = meter.measure({ messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    ] }] });
    expect(measurement).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/^deepseek_v41_projection_failed:/),
    });
  });

});
