import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
const { estimateMessagesTokens, estimateTextTokens, estimateToolsTokens } = llmProviderModelMeasurement;
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import { llmProviderCatalog } from '../../../src/foundation/llm-provider/index.js';
const { CATALOG_REVISION } = llmProviderCatalog;
import { isDeepseekV41MeterProfile } from '../../../src/foundation/llm-provider/input-meter.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';

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
    expect(meter.descriptor.contextWindow).toBe(1_000_000);
    expect(meter.descriptor.provider).toBe('deepseek');
    expect(meter.descriptor.windowResolution).toMatchObject({
      contextWindow: 1_000_000,
      source: 'catalog',
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
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

  it('describes the final DeepSeek projection, assets, limits, and effective options', async () => {
    const meter = await createLLMProvider(config).prepareInputMeter({ maxTokens: 8_192 });
    const otherBudget = await createLLMProvider(config).prepareInputMeter({ maxTokens: 4_096 });
    expect(meter.descriptor).toMatchObject({
      profile: 'deepseek-v41-flash-1017-v1',
      method: 'deepseek-v41-template',
      projection: 'pi-ai@1.4.0:anthropic-messages:buildApiKeyRequest',
      effectiveMaxTokens: 8_192,
      limits: { supportedTools: 'client' },
    });
    expect(meter.descriptor.assetRevision).toContain('deepseek-recipe@0.2.0');
    expect(meter.descriptor.assetRevision).toContain('81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99');
    expect(otherBudget.descriptor.revision).not.toBe(meter.descriptor.revision);
  });

  it.each([
    ['a same-name custom model', { catalogProvider: undefined, catalogModel: undefined }],
    ['a non-Anthropic wire protocol', { apiFormat: 'openai' as const }],
    ['an unapproved wire alias', { model: 'deepseek-flash-latest' }],
    ['a different resolved catalog model', { catalogModel: 'deepseek-v4-pro' }],
    ['a different resolved provider', {
      catalogProvider: 'fireworks',
      catalogModel: 'accounts/fireworks/models/deepseek-v4p1-flash',
    }],
    ['a catalog-model rather than metadata-only resolution', {
      catalogProvider: undefined,
      catalogModel: undefined,
      piAiProvider: 'deepseek',
      model: 'deepseek-flash',
    }],
  ])('keeps %s on the legacy estimated path', async (_name, overrides: Partial<ProviderConfig>) => {
    const meter = await createLLMProvider({ ...config, ...overrides }).prepareInputMeter();
    expect(meter.descriptor).toMatchObject({
      profile: 'legacy-cl100k-v2',
      method: 'legacy-cl100k',
      projection: 'estimate-only:no-final-wire-projection',
      assetRevision: 'js-tiktoken:cl100k_base',
      limits: { supportedTools: 'declared' },
    });
    expect(meter.project).toBeUndefined();
    expect(meter.measure({ messages: [{ role: 'user', content: 'hello' }] })).toMatchObject({
      kind: 'estimated',
      method: 'legacy-cl100k',
      reason: expect.stringMatching(/^unsupported_model_or_protocol:catalog=/),
    });
  });

  it('requires the resolved wire identity to match the qualified model', async () => {
    const { model, resolution } = resolvePiAiModel(await loadPiAiRuntime(), config);
    expect(isDeepseekV41MeterProfile(model, resolution)).toBe(true);
    expect(isDeepseekV41MeterProfile(model, {
      ...resolution,
      wire: { ...resolution.wire, model: 'deepseek-flash-latest' },
    })).toBe(false);
    expect(isDeepseekV41MeterProfile(model, {
      ...resolution,
      wire: { ...resolution.wire, api: 'openai-completions' },
    })).toBe(false);
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

  it('keeps multimodal content on the explicitly estimated fallback', async () => {
    const meter = await createLLMProvider({ ...config, catalogProvider: undefined,
      catalogModel: undefined, model: 'unknown-model' }).prepareInputMeter();
    const measurement = meter.measure({ messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    ] }] });
    expect(measurement).toMatchObject({
      kind: 'estimated',
      method: 'legacy-cl100k',
      reason: expect.stringContaining('model=unknown-model'),
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
    const messageTokens = messages.map(message => capability.measureMessage(message));
    expect(fixed).toBe(estimateTextTokens(system) + estimateToolsTokens(tools));
    expect(messageTokens).toEqual(messages.map(message => estimateMessagesTokens([message])));
    expect(meter.measure({ system, tools, messages })).toMatchObject({
      kind: 'estimated',
      tokens: fixed + messageTokens.reduce((sum, tokens) => sum + tokens, 0),
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
