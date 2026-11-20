import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { createLLMProvider } from '../../../src/foundation/llm-provider/provider-factory.js';
import { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
const { emitInputMeasurement, inputProjectionHash } = llmProviderModelMeasurement;
type InputArtifactOwner = llmProviderModelMeasurement.InputArtifactOwner;
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;
import { normalizeProviderUsageForMeasurement } from '../../../src/foundation/llm-provider/pi-ai-adapter.js';

/** Five seconds leaves ample room for the mocked SDK request to finish. */
const INPUT_OBSERVER_TIMEOUT_MS = 5_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockSuccessfulProvider(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response([
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })));
}

describe('input measurement observer', () => {
  it('keeps observation failures off the provider path and exposes them', () => {
    const critical = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => emitInputMeasurement(() => { throw new Error('sink failed'); }, {
      kind: 'failed', requestId: 'r1', provider: 'p', model: 'm', reason: 'x', inputSource: 'unlinked',
    })).not.toThrow();
    expect(critical).toHaveBeenCalledWith(expect.stringContaining('[LLM INPUT MEASUREMENT CRITICAL]'));
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
      inputSource: 'unlinked',
      usage: { unCachedInputTokens: 10, outputTokens: 2, cacheReadInputTokens: 4 },
      effectiveInputTokens: 14,
      normalizedUsageInputTokens: 14,
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
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    });
    await adapter.call({ messages: [{ role: 'user', content: 'hello' }], onInputMeasurement: fact => observations.push(fact) });
    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
    expect(observations[0]!.requestId).toBe(observations[1]!.requestId);
    expect(observations[0]).toMatchObject({
      measurement: { kind: 'estimated', method: 'legacy-cl100k' },
    });
    expect(observations[0]).not.toHaveProperty('usage');
    expect(observations[1]).toMatchObject({
      kind: 'completed',
      usage: {
        unCachedInputTokens: 3,
        outputTokens: 1,
        cacheWriteInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 4,
      },
      effectiveInputTokens: 3,
      normalizedUsageInputTokens: 3,
      inputSource: 'unlinked',
      descriptorRevision: observations[0]!.kind === 'prepared' ? observations[0].descriptor.revision : undefined,
      inputHash: observations[0]!.kind === 'prepared' ? observations[0].inputHash : undefined,
      artifactRef: { status: 'unavailable', reason: 'artifact_owner_unconfigured' },
    });
    expect(observations[1]!.artifactRef).toEqual(observations[0]!.artifactRef);
  });

  it.each([
    { status: 'available', inputSource: 'artifact' },
    { status: 'redacted', inputSource: 'unlinked' },
  ] as const)('shares a $status artifact manifest between prepared and terminal', async ({ status, inputSource }) => {
    mockSuccessfulProvider();
    const observations: InputMeasurementObservation[] = [];
    const capture = vi.fn().mockReturnValue({
      status,
      contentHash: 'a'.repeat(64),
      byteLength: 42,
      ...(status === 'redacted' ? { redactionPolicy: 'test-redactor-v1' } : {}),
    });
    const inputArtifactOwner: InputArtifactOwner = { capture };
    const adapter = createLLMProvider({
      name: `observer-artifact-${status}`, apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    }, { inputArtifactOwner });

    await adapter.call({
      messages: [{ role: 'user', content: 'hello' }],
      inputArtifactPolicy: { redactionPolicy: 'test-redactor-v1' },
      onInputMeasurement: fact => observations.push(fact),
    });

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      requestId: observations[0]!.requestId,
      input: expect.anything(),
      policy: { redactionPolicy: 'test-redactor-v1' },
    }));
    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
    expect(observations[0]).toMatchObject({ inputSource, artifactRef: { status, contentHash: 'a'.repeat(64), byteLength: 42 } });
    expect(observations[1]!.artifactRef).toEqual(observations[0]!.artifactRef);
    expect(JSON.stringify(observations)).not.toContain('hello');
  });

  it('degrades a failed artifact capture without changing the provider result', async () => {
    mockSuccessfulProvider();
    const observations: InputMeasurementObservation[] = [];
    const inputArtifactOwner: InputArtifactOwner = { capture: () => { throw new Error('secret capture failure'); } };
    const adapter = createLLMProvider({
      name: 'observer-artifact-failure', apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    }, { inputArtifactOwner });

    await expect(adapter.call({
      messages: [{ role: 'user', content: 'hello' }],
      onInputMeasurement: fact => observations.push(fact),
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'ok' }] });

    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
    expect(observations[0]).toMatchObject({
      inputSource: 'unlinked',
      artifactRef: { status: 'unavailable', reason: 'artifact_capture_failed' },
    });
    expect(observations[1]!.artifactRef).toEqual(observations[0]!.artifactRef);
    expect(JSON.stringify(observations)).not.toContain('secret capture failure');
  });

  it('emits at most one completed terminal when the SDK repeats done', async () => {
    const finalFrame = `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response([
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
      finalFrame,
      finalFrame,
      'data: [DONE]',
      '',
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const observations: InputMeasurementObservation[] = [];
    const adapter = createLLMProvider({
      name: 'observer-duplicate-done', apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    });

    await adapter.call({
      messages: [{ role: 'user', content: 'hello' }],
      onInputMeasurement: fact => observations.push(fact),
    });

    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
  });

  it('uses a fresh request id for each real automatic retry attempt', async () => {
    const budgetMessage = 'maximum context length is 8192 tokens. requested 9000 tokens (8000 in the messages, 1000 in the completion)';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: budgetMessage } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response([
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const observations: InputMeasurementObservation[] = [];
    const adapter = createLLMProvider({
      name: 'observer-retry', apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    });

    await adapter.call({
      messages: [{ role: 'user', content: 'hello' }], maxTokens: 1_000,
      onInputMeasurement: fact => observations.push(fact),
    });

    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'failed', 'prepared', 'completed']);
    expect(observations[0]!.requestId).toBe(observations[1]!.requestId);
    expect(observations[2]!.requestId).toBe(observations[3]!.requestId);
    expect(observations[0]!.requestId).not.toBe(observations[2]!.requestId);
    expect(observations[0]!.artifactRef?.artifactId).not.toBe(observations[2]!.artifactRef?.artifactId);
  });

  it('emits exactly one failed terminal for a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )));
    const observations: InputMeasurementObservation[] = [];
    const adapter = createLLMProvider({
      name: 'observer-error', apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    });

    await expect(adapter.call({
      messages: [{ role: 'user', content: 'hello' }],
      onInputMeasurement: fact => observations.push(fact),
    })).rejects.toThrow();

    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'failed']);
    expect(observations.filter(fact => fact.kind === 'failed')).toHaveLength(1);
    expect(observations[0]!.requestId).toBe(observations[1]!.requestId);
    expect(observations[1]).toMatchObject({
      descriptorRevision: observations[0]!.kind === 'prepared' ? observations[0].descriptor.revision : undefined,
      inputHash: observations[0]!.kind === 'prepared' ? observations[0].inputHash : undefined,
    });
  });

  it('defers meter setup failure until the SDK terminal instead of emitting conflicting terminals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response([
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const observations: InputMeasurementObservation[] = [];
    const adapter = createLLMProvider({
      name: 'observer-meter-error', apiKey: 'k', baseUrl: 'https://observer.invalid/v1', model: 'gpt-test',
      apiFormat: 'openai', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    });
    vi.spyOn(adapter, 'prepareInputMeter').mockRejectedValue(new Error('meter setup unavailable'));

    await adapter.call({
      messages: [{ role: 'user', content: 'hello' }],
      onInputMeasurement: fact => observations.push(fact),
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: 'completed',
      reconciliation: 'unavailable',
      inputSource: 'unlinked',
      measurement: { kind: 'unavailable', reason: 'meter setup unavailable' },
      effectiveInputTokens: 3,
      normalizedUsageInputTokens: 3,
    });
  });

  it('normalizes cache usage once and preserves raw values and terminal correlation facts', async () => {
    const frames = [
      ['message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }],
    ] as const;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}`).join('\n\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const observations: InputMeasurementObservation[] = [];
    const adapter = createLLMProvider({
      name: 'observer-cache', apiKey: 'k', baseUrl: 'https://observer.invalid', model: 'claude-test',
      apiFormat: 'anthropic', temperature: 0, timeoutMs: INPUT_OBSERVER_TIMEOUT_MS,
    });

    await adapter.call({
      messages: [{ role: 'user', content: 'hello' }],
      onInputMeasurement: fact => observations.push(fact),
    });

    expect(observations.map(fact => fact.kind)).toEqual(['prepared', 'completed']);
    const prepared = observations[0]!;
    const completed = observations[1]!;
    expect(completed).toMatchObject({
      usage: {
        unCachedInputTokens: 10,
        outputTokens: 4,
        cacheWriteInputTokens: 2,
        cacheReadInputTokens: 3,
        totalTokens: 19,
      },
      effectiveInputTokens: 15,
      normalizedUsageInputTokens: 15,
      inputSource: 'unlinked',
      descriptorRevision: prepared.kind === 'prepared' ? prepared.descriptor.revision : undefined,
      inputHash: prepared.kind === 'prepared' ? prepared.inputHash : undefined,
    });
    expect(completed).not.toHaveProperty('totalUsageInputTokens');
    if (completed.kind === 'completed') {
      expect(completed.deltaTokens).toBe(completed.effectiveInputTokens! - completed.measuredInputTokens!);
    }
  });

  it('returns no effective input when supplier usage is absent', () => {
    expect(normalizeProviderUsageForMeasurement(undefined)).toEqual({ invalidFields: [] });
  });

  it.each([
    [{ unCachedInputTokens: -1, outputTokens: 1 }, ['unCachedInputTokens']],
    [{ unCachedInputTokens: 1.5, outputTokens: 1 }, ['unCachedInputTokens']],
    [{ unCachedInputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 }, ['unCachedInputTokens']],
    [{ unCachedInputTokens: 1, outputTokens: 1, reasoningTokens: -1 }, ['reasoningTokens']],
  ])('classifies invalid supplier usage without producing an effective value', (usage, invalidFields) => {
    expect(normalizeProviderUsageForMeasurement(usage)).toEqual({ invalidFields });
  });

  it('classifies an unsafe effective-input sum without mutating raw usage', () => {
    const usage = {
      unCachedInputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      cacheReadInputTokens: 1,
    };
    expect(normalizeProviderUsageForMeasurement(usage)).toEqual({ invalidFields: ['effectiveInputTokens'] });
    expect(usage).toEqual({
      unCachedInputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      cacheReadInputTokens: 1,
    });
  });
});
