import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitInputMeasurement, inputProjectionHash, type InputMeasurementObservation, createLLMProvider } from '../../../src/foundation/llm-provider/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('input measurement observer', () => {
  it('keeps observation failures off the provider path', () => {
    expect(() => emitInputMeasurement(() => { throw new Error('sink failed'); }, {
      kind: 'failed', requestId: 'r1', provider: 'p', model: 'm', reason: 'x',
    })).not.toThrow();
  });

  it('hashes the input projection without exposing its contents', () => {
    const input = { messages: [{ role: 'user', content: 'secret text' }] };
    const hash = inputProjectionHash(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('secret');
  });

  it('represents usage reconciliation as a request-local fact', () => {
    const fact: InputMeasurementObservation = {
      kind: 'completed',
      requestId: 'r2', provider: 'p', model: 'm',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 4 },
      totalUsageInputTokens: 14,
      measuredInputTokens: 12,
      deltaTokens: 2,
      reconciliation: 'mismatch',
    };
    expect(fact.requestId).toBe('r2');
    expect(fact.reconciliation).toBe('mismatch');
  });

  it('emits a fresh prepared/completed pair for an actual SDK request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response([
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const observations: InputMeasurementObservation[] = [];
    const adapter = createLLMProvider({
      name: 'observer-test', apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: 5_000,
    });
    await adapter.call({ messages: [{ role: 'user', content: 'hello' }], onInputMeasurement: fact => observations.push(fact) });
    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
    expect(observations[0]!.requestId).toBe(observations[1]!.requestId);
    expect(observations[1]).toMatchObject({ kind: 'completed', totalUsageInputTokens: 3 });
  });
});
