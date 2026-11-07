import { describe, expect, it, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { classifyStreamDone } from '../../../src/foundation/llm-orchestrator/utils.js';
import type { LLMEvent, LLMEventSink, LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/types.js';
import { LLMError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type { ProviderAdapter, ProviderConfig, ProviderStreamChunk } from '../../../src/foundation/llm-provider/index.js';

interface MockProviderOptions {
  streamChunks?: ProviderStreamChunk[];
  streamDelayMs?: number;
  callError?: Error;
  callPending?: boolean;
}

function createMockProvider(name: string, options: MockProviderOptions = {}) {
  const callSpy = vi.fn(async () => {
    if (options.callPending) return new Promise<never>(() => {});
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
      ? async function* () {
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
  const findAdapter = (config: ProviderConfig) => {
    if (config.name === primary.name) return primary;
    return fallbacks.find(fallback => fallback.name === config.name) ?? primary;
  };
  const service = new LLMOrchestratorImpl({
    lifecycle: { mode: 'ephemeral' },
    primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' },
    fallbacks: fallbacks.map(fallback => ({
      name: fallback.name,
      apiKey: 'test',
      model: fallback.model,
      apiFormat: 'anthropic',
    })),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: eventSink,
    createProviderAdapter: findAdapter,
  });
  const now = Date.now();
  (service as any).providerStates = [{
    providerId: (service as any).providerIds[0],
    status: 'waiting',
    retryAt: now + 60_000,
    lastError: { class: 'transient', at: now, message: 'forced provider failure' },
    consecutiveFailures: 1,
  }];
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

function expectContextFailure(
  result: { chunks: LLMStreamChunk[]; caught: unknown },
  events: LLMEvent[],
) {
  expect(result.caught).toBeInstanceOf(LLMError);
  expect((result.caught as Error).message).toContain('context_window_exceeded');
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
  it('A wins: resets once and fails without waiting for or restarting B', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'partial' },
        { type: 'done', stopReason: 'model_context_window_exceeded' },
      ],
    });
    const returnSpy = spyOnPrimaryReturn(primaryRaw.provider);
    const fallback = createMockProvider('fallback', { callPending: true });
    const secondFallback = createMockProvider('fallback-2', { callPending: true });
    const { service, events } = createOrchestrator(
      primaryRaw.provider,
      [fallback.provider, secondFallback.provider],
    );
    const primaryStateBefore = structuredClone((service as any).providerStates[0]);

    const result = await collectStream(service);

    expectContextFailure(result, events);
    expect(fallback.callSpy).toHaveBeenCalledTimes(1);
    expect(secondFallback.callSpy).not.toHaveBeenCalled();
    expect((service as any).providerStates[0]).toEqual(primaryStateBefore);
    expect((service as any).lastSuccessProvider).toBeNull();
    expect(returnSpy).toHaveBeenCalled();
  });

  it('B-error then A wins: uses the same terminal failure and cleans up A', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamDelayMs: 10,
      streamChunks: [
        { type: 'text_delta', delta: 'partial' },
        { type: 'done', stopReason: 'context_length_exceeded' },
      ],
    });
    const returnSpy = spyOnPrimaryReturn(primaryRaw.provider);
    const fallback = createMockProvider('fallback', {
      callError: new LLMNetworkError('fallback', new Error('offline')),
    });
    const { service, events } = createOrchestrator(primaryRaw.provider, [fallback.provider]);
    const primaryStateBefore = structuredClone((service as any).providerStates[0]);

    const result = await collectStream(service);

    expectContextFailure(result, events);
    expect(fallback.callSpy).toHaveBeenCalledTimes(1);
    expect((service as any).providerStates[0]).toEqual(primaryStateBefore);
    expect((service as any).lastSuccessProvider).toBeNull();
    expect(returnSpy).toHaveBeenCalled();
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
    expect((service as any).providerStates[0]).toMatchObject({
      status: 'available',
      retryAt: undefined,
      consecutiveFailures: 0,
    });
    expect(events.some(event =>
      event.type === 'call_selection' && event.outcome === 'selected' && event.provider === 'primary'
    )).toBe(true);
  });
});
