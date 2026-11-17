import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
type LLMCallOptions = llmProviderCall.LLMCallOptions;
import { llmProviderProtocol } from '../../../src/foundation/llm-provider/index.js';
const { makeToolUseId } = llmProviderProtocol;
import { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
const { inputProjectionHash } = llmProviderModelMeasurement;
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;
import type { ProviderConfig } from '../../../src/foundation/llm-provider/types.js';
import { createDeepseekInputProjection } from '../../../src/foundation/llm-provider/deepseek-input-projection.js';
import { buildEffectiveCallOptions } from '../../../src/foundation/llm-provider/pi-ai-call-options.js';
import { resolvePiAiModel } from '../../../src/foundation/llm-provider/pi-ai-model.js';
import { loadPiAiRuntime } from '../../../src/foundation/llm-provider/pi-ai-runtime.js';

/** Offline projection fixture only needs a short, positive provider timeout. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;

const config: ProviderConfig = {
  name: 'deepseek', model: 'deepseek-flash[1m]', apiFormat: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', catalogProvider: 'deepseek',
  catalogModel: 'deepseek-flash', apiKey: 'offline-only', temperature: 0, timeoutMs: TEST_PROVIDER_TIMEOUT_MS,
};

afterEach(() => vi.unstubAllGlobals());

function anthropicResponse(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  return new Response(events.map(([type, data]) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('DeepSeek final protocol projection', () => {
  it('matches the payload captured from the real pi-ai streamSimple fetch path', async () => {
    const configured = { ...config, thinking: true, thinkingBudgetTokens: 4_096 };
    const toolUseId = makeToolUseId('call_1');
    const input: LLMCallOptions = {
      system: 'System 🌐',
      maxTokens: 8_192,
      temperature: 0.25,
      tools: [{
        name: 'lookup', description: 'Look up 你好',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' }, options: { type: 'object', properties: { exact: { type: 'boolean' } } } },
          required: ['query'],
        },
      }],
      messages: [
        { role: 'system', content: 'Folded system' },
        { role: 'user', content: 'Find 🔍' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'consider 🧠', signature: 'signature' },
          { type: 'text', text: 'I will look.' },
          { type: 'tool_use', id: toolUseId, name: 'lookup', input: { query: 'café', options: { exact: true } } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: 'result ✅' },
          { type: 'text', text: 'Continue 続き' },
        ] },
      ],
    };
    const fetchMock = vi.fn(async () => anthropicResponse());
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createLLMProvider(configured);
    const meter = await adapter.prepareInputMeter(input);

    const observations: InputMeasurementObservation[] = [];
    await adapter.call({
      ...input,
      onInputMeasurement: observation => observations.push(observation),
    });

    const { model } = resolvePiAiModel(await loadPiAiRuntime(), configured);
    const projected = createDeepseekInputProjection(
      configured,
      model,
      buildEffectiveCallOptions(configured, input),
    )(input);
    const actual = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(projected).toEqual(actual);
    expect(observations[0]).toMatchObject({
      kind: 'prepared', inputHash: inputProjectionHash(projected),
    });
    expect(observations[1]).toMatchObject({
      kind: 'completed', inputHash: inputProjectionHash(projected),
    });
    expect(actual.thinking).toMatchObject({ type: 'enabled', budget_tokens: 4_096 });
    const measurement = meter.measure(input);
    if (measurement.kind === 'unavailable') {
      throw new Error(`${measurement.reason}: ${JSON.stringify(projected.messages)}`);
    }
    expect(measurement).toMatchObject({ kind: 'counted', method: 'deepseek-v41-template' });
    expect(meter.descriptor.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the effective disabled-thinking payload rather than a hardcoded renderer default', async () => {
    const adapter = createLLMProvider(config);
    const meter = await adapter.prepareInputMeter();
    const { model } = resolvePiAiModel(await loadPiAiRuntime(), config);
    const input: LLMCallOptions = { messages: [{ role: 'user', content: 'hello' }] };
    const projected = createDeepseekInputProjection(
      config,
      model,
      buildEffectiveCallOptions(config, input),
    )(input);

    expect(projected.thinking).toEqual({ type: 'disabled' });
    expect(projected.output_config).toBeUndefined();
    expect(meter.measure(input).kind).toBe('counted');
  });
});
