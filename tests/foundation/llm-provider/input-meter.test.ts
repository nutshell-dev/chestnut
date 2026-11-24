import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
const { estimateMessagesTokens, estimateTextTokens, estimateToolsTokens } = llmProviderModelMeasurement;
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import { llmProviderCatalog } from '../../../src/foundation/llm-provider/index.js';
const { CATALOG_REVISION } = llmProviderCatalog;

/** Offline meter fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;

const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};
afterEach(() => vi.unstubAllGlobals());

describe('resolved model input meter', () => {
  it('keeps the wire alias and uses its resolved 1M window without network', async () => {
    const fetch = vi.fn(() => { throw new Error('network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    const meter = await createLLMProvider(config).prepareInputMeter();
    expect(meter.descriptor.model).toBe('deepseek-flash[1m]');
    expect(meter.descriptor.configuredModel).toBe(config.model);
    expect(meter.descriptor.contextWindow).toBe(1_000_000);
    expect(meter.descriptor.provider).toBe('deepseek');
    expect(meter.descriptor.windowResolution).toMatchObject({
      contextWindow: 1_000_000,
      source: 'heuristic',
      providerId: 'deepseek',
      modelId: 'deepseek-flash[1m]',
    });
    expect(meter.descriptor.windowResolution?.revision).toBe(CATALOG_REVISION);
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

  it('describes the DeepSeek family estimate, assets, limits, and effective options', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter({ maxTokens: 8_192 });
    const otherBudget = await createLLMProvider(config).prepareInputMeter({ maxTokens: 4_096 });
    expect(meter.descriptor).toMatchObject({
      profile: 'deepseek-v41-text-v1',
      method: 'deepseek-v41-text',
      projection: 'estimate-only:no-final-wire-projection',
      effectiveMaxTokens: 8_192,
      limits: { supportedTools: 'declared' },
    });
    expect(meter.descriptor.assetRevision).toContain('deepseek-recipe@0.2.0');
    expect(meter.descriptor.assetRevision).toContain('81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99');
    expect(otherBudget.descriptor.revision).not.toBe(meter.descriptor.revision);
  });

  it.each([
    ['custom resolution', { catalogProvider: undefined, catalogModel: undefined }],
    ['OpenAI protocol', { apiFormat: 'openai' as const }],
    ['another DeepSeek model', { model: 'deepseek-flash-latest' }],
    ['another catalog model', { catalogModel: 'deepseek-v4-pro' }],
    ['another provider', {
      catalogProvider: 'fireworks', catalogModel: 'accounts/fireworks/models/deepseek-v4p1-flash',
    }],
  ])('keeps DeepSeek family estimation with %s', async (_name, overrides: Partial<ProviderConfig>) => {
    const meter = await createLLMProvider({ ...config, ...overrides }).prepareInputMeter();
    expect(meter.descriptor).toMatchObject({
      profile: 'deepseek-v41-text-v1', method: 'deepseek-v41-text',
      projection: 'estimate-only:no-final-wire-projection', limits: { supportedTools: 'declared' },
    });
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
      kind: 'estimated', method: 'deepseek-v41-text',
    });
  });

  it('labels unknown models as estimates', async () => {
    const meter = await createLLMProvider({ ...config, catalogProvider: undefined,
      catalogModel: undefined, model: 'unknown-model' }).prepareInputMeter();
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toEqual({
      kind: 'estimated',
      method: 'legacy-cl100k',
      reason: 'unsupported_model_or_protocol:catalog=custom;provider=unresolved;model=unknown-model;wireModel=unknown-model;api=anthropic-messages',
      tokens: expect.any(Number),
    });
  });

  it('keeps multimodal content explicitly unavailable on the fallback', async () => {
    const meter = await createLLMProvider({ ...config, catalogProvider: undefined,
      catalogModel: undefined, model: 'unknown-model' }).prepareInputMeter();
    const measurement = meter.measure({ messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    ] }] });
    expect(measurement).toEqual({
      kind: 'unavailable',
      reason: 'legacy_cl100k_estimate_unavailable:non_text_content',
    });
  });

  it('declares message-additive counting whose fixed and message terms equal complete measurement', async () => {
    const meter = await createLLMProvider({ ...config, catalogProvider: undefined,
      catalogModel: undefined, model: 'unknown-model' }).prepareInputMeter();
    const capability = meter.capability;
    if (capability.kind !== 'message_additive') {
      throw new Error(`expected message-additive meter, got ${capability.kind}`);
    }
    const system = 'count the fixed context';
    const tools = [{ name: 'lookup', description: 'lookup a value', input_schema: { type: 'object' } }];
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'world' }] },
    ];

    const fixed = capability.measureFixed({ system, tools });
    const messageMeasurements = messages.map(message => capability.measureMessage(message));
    expect(fixed).toMatchObject({
      kind: 'estimated', tokens: estimateTextTokens(system) + estimateToolsTokens(tools),
    });
    expect(messageMeasurements).toEqual(messages.map(message => ({
      kind: 'estimated', method: 'legacy-cl100k', reason: expect.any(String),
      tokens: estimateMessagesTokens([message]),
    })));
    if (fixed.kind === 'unavailable' || messageMeasurements.some(measurement => measurement.kind === 'unavailable')) {
      throw new Error('expected successful additive measurements');
    }
    expect(meter.measure({ system, tools, messages })).toMatchObject({
      kind: 'estimated',
      tokens: fixed.tokens + messageMeasurements.reduce((sum, measurement) => sum + measurement.tokens, 0),
    });
    expect(meter.descriptor.profile).toBe('legacy-cl100k-v2');
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
