/**
 * LLMOrchestrator stream/call/hedge regression tests — Phase 895 + Phase 896
 *
 * Phase 895:
 * 1. stream() user abort during idle probe propagates as AbortError with reason.
 * 2. stream() ending without done chunk emits reset + provider_failed and records breaker failure.
 * 3. stream() yielding only done without content failovers.
 *
 * Phase 896:
 * 1. call() user abort propagates immediately without collecting as failure.
 * 2. hedge A-win drain ending without done chunk emits reset + provider_failed.
 * 3. B-all-failed A-wins drain error emits reset and records breaker failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError, LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

// Phase 896 helper: declarative chunk/error based mock provider.
function createMockProvider(
  name: string,
  opts: {
    streamChunks?: StreamChunk[];
    streamError?: Error;
    streamErrorAfter?: number;
    callResponse?: LLMResponse;
    callError?: Error;
    callDelayMs?: number;
  } = {},
): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call(callOpts?: { signal?: AbortSignal }) {
      if (opts.callDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.callDelayMs);
          callOpts?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
      }
      if (opts.callError) throw opts.callError;
      return opts.callResponse ?? {
        content: [{ type: 'text', text: `Response from ${name}` }],
        stop_reason: 'end_turn',
      };
    },
    stream: opts.streamChunks || opts.streamError || opts.streamErrorAfter !== undefined
      ? async function* (streamOpts?: { signal?: AbortSignal }) {
          const chunks = opts.streamChunks ?? [];
          let count = 0;
          for (const chunk of chunks) {
            yield chunk;
            count++;
            if (opts.streamErrorAfter !== undefined && count >= opts.streamErrorAfter) {
              throw opts.streamError ?? new Error('stream error');
            }
          }
          if (opts.streamError && chunks.length === 0) {
            throw opts.streamError;
          }
        }
      : undefined,
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const service = new LLMOrchestratorImpl({
    primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
    fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, apiFormat: 'anthropic' as const })),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: noopSink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
  });
  (service as any).primary = primary;
  (service as any).fallbacks = fallbacks;
  return service;
}

function forceBreakerOpen(service: LLMOrchestratorImpl, index: number, cause: 'transient' | 'permanent' | 'rate_limit') {
  const breaker = (service as any).breakers[index] as CircuitBreaker;
  breaker['onFailure'](cause);
}

function attachEventSpy(service: LLMOrchestratorImpl) {
  const emitted: LLMEvent[] = [];
  const sink = (service as any).events as LLMEventSink;
  const originalEmit = sink.emit.bind(sink);
  sink.emit = (event: LLMEvent) => {
    emitted.push(event);
    originalEmit(event);
  };
  return emitted;
}

vi.mock('../../../src/foundation/llm-provider/anthropic.js', () => ({
  AnthropicAdapter: class MockAnthropicAdapter {
    name = 'mock-anthropic';
    model = 'mock-model';
    constructor(public config: any) {}
    async call() {
      return { content: [{ type: 'text', text: 'mock response' }], stop_reason: 'end_turn' };
    }
    async *stream() {
      yield { type: 'text_delta', delta: 'mock chunk' };
      yield { type: 'done' };
    }
  },
}));

describe('LLMOrchestratorImpl Phase 896 fixes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('propagates user abort from call() immediately without collecting as failure', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort({ type: 'user' });
    const primary = createMockProvider('primary');
    const primaryCallSpy = vi.spyOn(primary, 'call').mockRejectedValue(new Error('should not be thrown'));
    const fallback = createMockProvider('fb1');
    const fallbackCallSpy = vi.spyOn(fallback, 'call').mockResolvedValue({
      content: [{ type: 'text', text: 'fb response' }],
      stop_reason: 'end_turn',
    });
    const service = createOrchestrator(primary, [fallback]);

    await expect(service.call({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal }))
      .rejects.toThrow('Execution aborted (cause=user)');

    expect(primaryCallSpy).not.toHaveBeenCalled();
    expect(fallbackCallSpy).not.toHaveBeenCalled();
  });

  it('hedge A-win emits reset and provider_failed when primary drain ends without done', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'text_delta', delta: 'hello' }], // clean EOF, no done
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 500,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const breaker = (service as any).breakers[0] as CircuitBreaker;
    const onFailureSpy = vi.spyOn(breaker, 'onFailure');

    const chunks: StreamChunk[] = [];
    let caught: Error | undefined;
    try {
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(chunks.find(c => c.type === 'reset')).toBeDefined();
    expect(chunks.find(c => c.type === 'provider_failed')).toBeDefined();
    expect(events.some(e => e.type === 'stream_reset')).toBe(true);
    expect(caught).toBeDefined();
    expect(onFailureSpy).toHaveBeenCalledWith('transient');
  });

  it('hedge B-all-failed A-wins drain error emits reset and records breaker failure', async () => {
    const drainErr = new LLMNetworkError('primary', new Error('ECONNRESET'));
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'text_delta', delta: 'hello' }],
      streamErrorAfter: 1,
      streamError: drainErr,
    });
    const fb1 = createMockProvider('fb1', {
      callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
    });
    const service = createOrchestrator(primary, [fb1]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const breaker = (service as any).breakers[0] as CircuitBreaker;
    const onFailureSpy = vi.spyOn(breaker, 'onFailure');

    const chunks: StreamChunk[] = [];
    let caught: Error | undefined;
    try {
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(chunks.find(c => c.type === 'reset')).toBeDefined();
    expect(events.some(e => e.type === 'hedge_primary_post_first_chunk_failure')).toBe(true);
    expect(events.some(e => e.type === 'stream_reset')).toBe(true);
    expect(caught).toBeDefined();
    expect(onFailureSpy).toHaveBeenCalled();
  });
});

// Phase 895 helper: function-based mock provider for streaming scenarios.
function createMockStreamProvider(
  name: string,
  streamImpl?: (opts: { signal?: AbortSignal }) => AsyncGenerator<StreamChunk>,
  callImpl?: (opts?: { signal?: AbortSignal }) => Promise<any>,
): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call(opts?: { signal?: AbortSignal }) {
      if (callImpl) return callImpl(opts);
      return {
        content: [{ type: 'text', text: `Response from ${name}` }],
        stop_reason: 'end_turn',
      };
    },
    stream: streamImpl
      ? streamImpl
      : async function* () {
          yield { type: 'text_delta', delta: `Chunk from ${name}` };
          yield { type: 'done' };
        },
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };
}

const MOCK_PRIMARY_CONFIG = { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const };
const MOCK_FALLBACK_CONFIG = { name: 'fallback', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const };

// Delay before the probe aborts the user signal.
// Derivation: streamIdleTimeoutMs=50ms must fire first; 20ms is short enough
// to keep the test fast while ensuring the probe runs after idle timeout.
const PROBE_ABORT_DELAY_MS = 20;

describe('Phase 895 — orchestrator stream fixes', () => {
  it('throws AbortError with user reason when user aborts during idle probe', async () => {
    const { sink } = createMockSink();
    const abortCtrl = new AbortController();

    const primary = createMockStreamProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        yield { type: 'text_delta', delta: 'first' };
        // Hang until the idle timeout aborts the merged signal.
        await new Promise<void>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new Error('AbortError'));
          });
        });
        yield { type: 'done' };
      },
      async (opts?: { signal?: AbortSignal }) => {
        // Simulate a probe that notices the user abort after a short delay.
        await new Promise((resolve) => setTimeout(resolve, PROBE_ABORT_DELAY_MS));
        abortCtrl.abort({ type: 'user' as const });
        const err = new Error('Execution aborted');
        err.name = 'AbortError';
        throw err;
      },
    );

    const service = new LLMOrchestratorImpl({
      primary: MOCK_PRIMARY_CONFIG,
      maxAttempts: 2,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;

    const promise = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of service.stream({
        messages: [],
        streamIdleTimeoutMs: 50,
        streamIdleProbeTimeoutMs: 50,
        signal: abortCtrl.signal,
      })) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    let caught: Error | undefined;
    try {
      await promise;
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe('AbortError');
    expect(caught!.message).toMatch(/Execution aborted/);
    expect((caught! as Error & { cause?: { type: string } }).cause?.type).toBe('user');
  });

  it('records breaker failure when stream ends without done chunk', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockStreamProvider(
      'primary',
      async function* () {
        yield { type: 'text_delta', delta: 'partial' };
        // Clean EOF without a done chunk.
      },
    );

    const fallback = createMockStreamProvider(
      'fallback',
      async function* () {
        yield { type: 'text_delta', delta: 'full' };
        yield { type: 'done' };
      },
    );

    const service = new LLMOrchestratorImpl({
      primary: MOCK_PRIMARY_CONFIG,
      fallbacks: [MOCK_FALLBACK_CONFIG],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1_000 },
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const breaker = (service as any).breakers[0];
    const onFailureSpy = vi.spyOn(breaker, 'onFailure');

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50 })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'text_delta').map((c: any) => c.delta)).toEqual(['partial', 'full']);
    expect(chunks.filter((c) => c.type === 'reset').length).toBe(1);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    expect(chunks.some((c) => c.type === 'provider_failed' && (c as any).provider === 'primary')).toBe(true);
    expect(onFailureSpy).toHaveBeenCalled();
    expect(emitted.some((e) => e.type === 'fallback_switched')).toBe(true);
  });

  it('failovers when stream yields only done without content', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockStreamProvider(
      'primary',
      async function* () {
        yield { type: 'done', stopReason: 'end_turn' };
      },
    );

    const fallback = createMockStreamProvider(
      'fallback',
      async function* () {
        yield { type: 'text_delta', delta: 'fallback-content' };
        yield { type: 'done' };
      },
    );

    const service = new LLMOrchestratorImpl({
      primary: MOCK_PRIMARY_CONFIG,
      fallbacks: [MOCK_FALLBACK_CONFIG],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'reset').length).toBe(1);
    expect(chunks.filter((c) => c.type === 'done').length).toBe(1);
    expect(chunks.some((c) => c.type === 'text_delta' && (c as any).delta === 'fallback-content')).toBe(true);
    expect(chunks.some((c) => c.type === 'provider_failed' && (c as any).provider === 'primary')).toBe(true);
    expect(emitted.some((e) => e.type === 'fallback_switched')).toBe(true);
  });
});
