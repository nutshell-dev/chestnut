import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import * as tokenEstimator from '../../../src/foundation/llm-provider/token-estimator.js';
import { CommonInputProjectionUnsupported } from '../../../src/foundation/llm-provider/common-input-projection.js';

const config: ProviderConfig = {
  name: 'offline', model: 'unknown-model', apiFormat: 'anthropic',
  baseUrl: 'https://offline.invalid', apiKey: 'offline-only', temperature: 0, timeoutMs: 1_000,
};

async function createAdditiveMeter() {
  const meter = await createLLMProvider(config).prepareInputMeter();
  if (meter.capability.kind !== 'message_additive') {
    throw new Error(`expected message-additive meter, got ${meter.capability.kind}`);
  }
  return meter as typeof meter & { capability: Extract<typeof meter.capability, { kind: 'message_additive' }> };
}

afterEach(() => vi.restoreAllMocks());

describe('legacy cl100k additive measurement failures', () => {
  it('returns unavailable when fixed text estimation fails', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockImplementation(() => {
      throw new TypeError('fixed text sentinel');
    });
    const meter = await createAdditiveMeter();

    expect(meter.capability.measureFixed({ system: 'system', tools: [] })).toEqual({
      kind: 'unavailable', reason: 'legacy_cl100k_estimate_unavailable:TypeError',
    });
  });

  it('returns unavailable when fixed tools estimation fails', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(1);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockImplementation(() => {
      throw new RangeError('fixed tools sentinel');
    });
    const meter = await createAdditiveMeter();
    const tools = [{ name: 'lookup', description: 'lookup', input_schema: { type: 'object' } }];

    expect(meter.capability.measureFixed({ tools })).toEqual({
      kind: 'unavailable', reason: 'legacy_cl100k_estimate_unavailable:RangeError',
    });
  });

  it('returns unavailable when message estimation fails and complete measurement short-circuits', async () => {
    const estimate = vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockImplementation(() => {
      throw new SyntaxError('message sentinel');
    });
    const meter = await createAdditiveMeter();
    const first = { role: 'user' as const, content: 'first' };
    const second = { role: 'user' as const, content: 'second' };

    const additive = meter.capability.measureMessage(first);
    expect(additive).toEqual({
      kind: 'unavailable', reason: 'legacy_cl100k_estimate_unavailable:SyntaxError',
    });
    expect(meter.measure({ messages: [first, second] })).toEqual(additive);
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it('preserves projection failure reasons in additive message results', async () => {
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockImplementation(() => {
      throw new CommonInputProjectionUnsupported('non_text_content');
    });
    const meter = await createAdditiveMeter();

    expect(meter.capability.measureMessage({ role: 'user', content: 'message' })).toEqual({
      kind: 'unavailable', reason: 'legacy_cl100k_estimate_unavailable:non_text_content',
    });
  });

  it('returns the fixed failure directly without measuring later messages', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockImplementation(() => {
      throw new EvalError('fixed sentinel');
    });
    const messages = vi.spyOn(tokenEstimator, 'estimateMessagesTokens');
    const meter = await createAdditiveMeter();

    expect(meter.measure({ system: 'system', messages: [{ role: 'user', content: 'later' }] })).toEqual({
      kind: 'unavailable', reason: 'legacy_cl100k_estimate_unavailable:EvalError',
    });
    expect(messages).not.toHaveBeenCalled();
  });
});
