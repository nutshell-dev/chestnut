import { describe, expect, it } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/index.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: 1000,
};

describe('DeepSeek V4.1 input meter', () => {
  it('matches the official renderer for system + user input', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter();
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
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }], tools: [{
      name: 'server', description: '', input_schema: { type: 'object' },
      type: 'computer_20250101',
    } as never] }).kind).toBe('unavailable');
  });

});
