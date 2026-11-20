import { legacyProviderFactory } from './provider-test-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { classifyStreamDone } from '../../../src/foundation/llm-orchestrator/utils.js';
import type { LLMEvent, LLMEventSink, LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/types.js';
import { LLMContextExceededError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
type ProviderAdapter = llmProviderCall.ProviderAdapter;
type ProviderStreamChunk = llmProviderCall.ProviderStreamChunk;
import type { ProviderConnection } from './provider-test-fixtures.js';
import { internalsOf, providerStatesOf, replaceProviderStates, lastSuccessProviderOf } from './test-internals.js';
import { InvocationSelectionLedger } from '../../../src/foundation/llm-orchestrator/invocation-selection-ledger.js';
type LLMCallOptions = llmProviderCall.LLMCallOptions;
type LLMResponse = llmProviderCall.LLMResponse;

/** Delays the primary stream so the fallback failure is observed before its terminal context-done. */
const PRIMARY_AFTER_FALLBACK_ERROR_DELAY_MS = 10;

interface MockProviderOptions {
  streamChunks?: ProviderStreamChunk[];
  streamDelayMs?: number;
  callError?: Error;
  callPending?: boolean;
  callPromise?: Promise<LLMResponse>;
  measurementRequestId?: string;
}

function createMockProvider(name: string, options: MockProviderOptions = {}) {
  const callSpy = vi.fn(async (callOpts?: LLMCallOptions) => {
    if (options.measurementRequestId) {
      callOpts?.onInputMeasurement?.({
        kind: 'completed', requestId: options.measurementRequestId,
        provider: name, model: 'mock-model', inputSource: 'unlinked', reconciliation: 'no_usage',
      });
    }
    if (options.callPending) return new Promise<never>(() => {});
    if (options.callPromise) return options.callPromise;
    if (options.callError) throw options.callError;
    return {
      content: [{ type: 'text' as const, text: `Response from ${name}` }],
      stop_reason: 'end_turn',
    };
  });
  const provider: ProviderAdapter = {
    name,
    model: 'mock-model',
    call: callSpy,
    stream: options.streamChunks
      ? async function* (streamOpts?: LLMCallOptions) {
          if (options.measurementRequestId) {
            streamOpts?.onInputMeasurement?.({
              kind: 'completed', requestId: options.measurementRequestId,
              provider: name, model: 'mock-model', inputSource: 'unlinked', reconciliation: 'no_usage',
            });
          }
          if (options.streamDelayMs) {
            await new Promise(resolve => setTimeout(resolve, options.streamDelayMs));
          }
          yield* options.streamChunks!;
        }
      : undefined,
  };
  return { provider, callSpy };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const events: LLMEvent[] = [];
  const eventSink: LLMEventSink = { emit: event => events.push(event) };
  const findAdapter = (config: ProviderConnection) => {
    if (config.providerId === primary.name) return primary;
    return fallbacks.find(fallback => fallback.name === config.providerId) ?? primary;
  };
  const service = new LLMOrchestratorImpl({
    lifecycle: { mode: 'ephemeral' },
    primary: { providerId: primary.name, authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' }, model: primary.model, apiFormat: 'anthropic' },
    fallbacks: fallbacks.map(fallback => ({ providerId: fallback.name, authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' }, model: fallback.model, apiFormat: 'anthropic' })),
    maxAttempts: 1,
    retryDelayMs: 0, // 禁用重试等待，保持流式竞态确定。
    events: eventSink,
    providerFactory: legacyProviderFactory(findAdapter),
  });
  const now = Date.now();
  replaceProviderStates(service, [{
    providerId: internalsOf(service).providerRuntime.providerIds()[0],
    status: 'waiting',
    retryAt: now + 60_000,
    lastError: { class: 'transient', at: now, message: 'forced provider failure' },
    consecutiveFailures: 1,
  }]);
  return { service, events };
}

function spyOnPrimaryReturn(provider: ProviderAdapter) {
  const returnSpy = vi.fn();
  const originalStream = provider.stream!.bind(provider);
  provider.stream = options => {
    const iterator = originalStream(options);
    const originalReturn = iterator.return.bind(iterator);
    iterator.return = async value => {
      returnSpy();
      return originalReturn(value);
    };
    return iterator;
  };
  return returnSpy;
}

async function collectStream(service: LLMOrchestratorImpl) {
  const chunks: LLMStreamChunk[] = [];
  let caught: unknown;
  try {
    for await (const chunk of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }
  } catch (error) {
    caught = error;
  }
  return { chunks, caught };
}

function expectMixedContextFailure(
  result: { chunks: LLMStreamChunk[]; caught: unknown },
  events: LLMEvent[],
) {
  expect(result.caught).toBeInstanceOf(LLMAllProvidersFailedError);
  const aggregate = result.caught as LLMAllProvidersFailedError;
  expect(aggregate.failures.map(failure => failure.provider)).toEqual(['primary', 'fallback']);
  expect(aggregate.evidence.map(failure => failure.family)).toEqual(['context_exceeded', 'transient']);
  expect(events.filter(event => event.type === 'all_providers_context_exceeded')).toHaveLength(0);
  expect(result.chunks).toEqual([
    { type: 'text_delta', delta: 'partial' },
    { type: 'reset', provider: 'primary' },
  ]);
  expect(result.chunks.filter(chunk => chunk.type === 'reset')).toHaveLength(1);
  expect(result.chunks.some(chunk => chunk.type === 'done')).toBe(false);
  expect(events.filter(event =>
    event.type === 'call_attempt_result'
    && event.provider === 'primary'
    && event.outcome === 'failure'
    && event.errorClass === 'context_exceeded'
  )).toHaveLength(1);
  expect(events.filter(event => event.type === 'call_selection' && event.outcome === 'exhausted')).toHaveLength(1);
  expect(events.some(event => event.type === 'call_selection' && event.outcome === 'selected')).toBe(false);
  expect(events.some(event => event.type === 'hedge_primary_recovered')).toBe(false);
}

describe('shared stream done classification', () => {
  it('distinguishes content, normal done, and both context-exceeded stop reasons', () => {
    expect(classifyStreamDone({ type: 'text_delta', delta: 'x' })).toBe('not_done');
    expect(classifyStreamDone({ type: 'done', stopReason: 'end_turn' })).toBe('done');
    expect(classifyStreamDone({ type: 'done', stopReason: 'model_context_window_exceeded' })).toBe('context_exceeded');
    expect(classifyStreamDone({ type: 'done', stopReason: 'context_length_exceeded' })).toBe('context_exceeded');
  });
});

describe('hedge primary context-done', () => {
  it('A wins then context-done: resets, finishes in-flight B, and continues unattempted B without repeats', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'partial' },
        { type: 'done', stopReason: 'model_context_window_exceeded' },
      ],
    });
    const returnSpy = spyOnPrimaryReturn(primaryRaw.provider);
    let rejectFallback!: (error: Error) => void;
    const fallbackResponse = new Promise<LLMResponse>((_resolve, reject) => { rejectFallback = reject; });
    const fallback = createMockProvider('fallback', { callPromise: fallbackResponse });
    const secondFallback = createMockProvider('fallback-2');
    const { service, events } = createOrchestrator(
      primaryRaw.provider,
      [fallback.provider, secondFallback.provider],
    );
    const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);

    const collecting = collectStream(service);
    await vi.waitFor(() => expect(fallback.callSpy).toHaveBeenCalledTimes(1));
    rejectFallback(new LLMNetworkError('fallback', new Error('offline')));
    const result = await collecting;

    expect(result.caught).toBeUndefined();
    expect(result.chunks).toEqual([
      { type: 'text_delta', delta: 'partial' },
      { type: 'reset', provider: 'primary' },
      { type: 'text_delta', delta: 'Response from fallback-2' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(events.filter(event =>
      event.type === 'call_attempt_result'
      && event.provider === 'primary'
      && event.outcome === 'failure'
      && event.errorClass === 'context_exceeded'
    )).toHaveLength(1);
    expect(events.some(event =>
      event.type === 'call_selection' && event.outcome === 'selected' && event.provider === 'fallback-2'
    )).toBe(true);
    expect(events.some(event => event.type === 'call_selection' && event.outcome === 'exhausted')).toBe(false);
    expect(fallback.callSpy).toHaveBeenCalledTimes(1);
    expect(secondFallback.callSpy).toHaveBeenCalledTimes(1);
    expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
    expect(lastSuccessProviderOf(service)).toMatchObject({ name: 'fallback-2' });
    expect(returnSpy).toHaveBeenCalled();
  });

  it('B-error then A wins: uses the same terminal failure and cleans up A', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamDelayMs: PRIMARY_AFTER_FALLBACK_ERROR_DELAY_MS,
      streamChunks: [
        { type: 'text_delta', delta: 'partial' },
        { type: 'done', stopReason: 'context_length_exceeded' },
      ],
      measurementRequestId: 'context-primary-request',
    });
    const returnSpy = spyOnPrimaryReturn(primaryRaw.provider);
    const fallback = createMockProvider('fallback', {
      callError: new LLMNetworkError('fallback', new Error('offline')),
      measurementRequestId: 'context-fallback-request',
    });
    const { service, events } = createOrchestrator(primaryRaw.provider, [fallback.provider]);
    const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);

    const result = await collectStream(service);

    expectMixedContextFailure(result, events);
    expect(fallback.callSpy).toHaveBeenCalledTimes(1);
    expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
    expect(lastSuccessProviderOf(service)).toBeNull();
    expect(returnSpy).toHaveBeenCalled();

    const started = events.find(event => event.type === 'call_invocation_started');
    if (started?.type !== 'call_invocation_started') throw new Error('expected invocation start');
    const replay = InvocationSelectionLedger.replay(events);
    const invocation = replay.invocations.get(started.invocationId);
    expect(invocation?.status).toBe('exhausted');
    expect([...invocation!.attempts.values()].find(item => item.provider === 'primary')).toMatchObject({
      status: 'failed', requestIds: ['context-primary-request'],
    });
    expect([...invocation!.attempts.values()].find(item => item.provider === 'fallback')).toMatchObject({
      status: 'failed', requestIds: ['context-fallback-request'],
    });
    expect(replay.diagnostics).toEqual([]);
  });

  it('A context-done plus B context failure aggregates all context evidence', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'partial' },
        { type: 'done', stopReason: 'model_context_window_exceeded' },
      ],
    });
    const fallback = createMockProvider('fallback', {
      callError: new LLMContextExceededError('fallback', 413, 'too large'),
    });
    const { service, events } = createOrchestrator(primary.provider, [fallback.provider]);

    const result = await collectStream(service);

    expect(result.caught).toBeInstanceOf(LLMAllProvidersFailedError);
    const aggregate = result.caught as LLMAllProvidersFailedError;
    expect(aggregate.failures.map(failure => failure.provider)).toEqual(['primary', 'fallback']);
    expect(aggregate.evidence.map(failure => failure.family)).toEqual(['context_exceeded', 'context_exceeded']);
    expect(result.chunks).toEqual([
      { type: 'text_delta', delta: 'partial' },
      { type: 'reset', provider: 'primary' },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'all_providers_context_exceeded', totalAttempted: 2, skippedCount: 0,
    }));
    expect(fallback.callSpy).toHaveBeenCalledTimes(1);
  });

  it('normal A done still yields done and records primary recovery', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'partial' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const fallback = createMockProvider('fallback', { callPending: true });
    const { service, events } = createOrchestrator(primary.provider, [fallback.provider]);

    const result = await collectStream(service);

    expect(result.caught).toBeUndefined();
    expect(result.chunks).toEqual([
      { type: 'text_delta', delta: 'partial' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(events.some(event => event.type === 'hedge_primary_recovered')).toBe(true);
    expect(providerStatesOf(service)[0]).toMatchObject({
      status: 'available',
      retryAt: undefined,
      consecutiveFailures: 0,
    });
    expect(events.some(event =>
      event.type === 'call_selection' && event.outcome === 'selected' && event.provider === 'primary'
    )).toBe(true);
  });
});
