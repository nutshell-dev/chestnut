/**
 * Phase 1374 sub-2: race loser cleanup explicit finally
 * Reverse test ≥3项: mock 2 provider race + winner 后 loser stream 显式 close + audit emit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockProvider(
  name: string,
  opts: {
    streamChunks?: StreamChunk[];
    streamError?: Error;
    streamDelayMs?: number;
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
    stream: opts.streamChunks || opts.streamError
      ? async function* (streamOpts?: { signal?: AbortSignal }) {
          if (opts.streamDelayMs) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, opts.streamDelayMs);
              streamOpts?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('AbortError'));
              });
            });
          }
          if (opts.streamError) throw opts.streamError;
          for (const chunk of (opts.streamChunks ?? [])) {
            yield chunk;
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

/**
 * Wrap a provider's stream generator so that .return() calls are spyable.
 */
function wrapProviderStreamWithReturnSpy(provider: ProviderAdapter) {
  const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
  if (!provider.stream) return { provider, returnSpy };

  const originalStream = provider.stream.bind(provider);
  provider.stream = function (opts?: { signal?: AbortSignal }) {
    const gen = originalStream(opts);
    const originalReturn = gen.return.bind(gen);
    gen.return = async function (value?: unknown) {
      returnSpy(value);
      return originalReturn(value);
    };
    return gen;
  };

  return { provider, returnSpy };
}

function createEventSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

describe('phase 1374 sub-2: race loser cleanup explicit finally', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverse 1: B wins → primaryIter.return() called + race_loser_cleaned emitted', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
      streamDelayMs: 500,
    });
    const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

    const fb1 = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 50,
    });
    const { sink, emitted } = createEventSink();
    const service = createOrchestrator(primary, [fb1]);
    (service as any).events = sink;
    forceBreakerOpen(service, 0, 'transient');

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'fb response')).toBe(true);
    expect(returnSpy).toHaveBeenCalledTimes(1);
    const cleaned = emitted.filter(e => e.type === 'race_loser_cleaned');
    expect(cleaned.length).toBe(1);
    expect(cleaned[0]).toMatchObject({ provider: 'primary', reason: 'hedge_trackB_won' });
  });

  it('reverse 2: A wins → primaryIter.return() called in finally (explicit cleanup)', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
      streamDelayMs: 10,
    });
    const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

    const fb1 = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 500,
    });
    const service = createOrchestrator(primary, [fb1]);
    forceBreakerOpen(service, 0, 'transient');

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'hello')).toBe(true);
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('reverse 3: B wins + primaryIter.return throws → silent + race_loser_cleaned still emitted', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
      streamDelayMs: 500,
    });
    const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);
    returnSpy.mockImplementation(async () => {
      throw new Error('generator return explosion');
    });

    const fb1 = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 50,
    });
    const { sink, emitted } = createEventSink();
    const service = createOrchestrator(primary, [fb1]);
    (service as any).events = sink;
    forceBreakerOpen(service, 0, 'transient');

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'fb response')).toBe(true);
    expect(returnSpy).toHaveBeenCalledTimes(1);
    const cleaned = emitted.filter(e => e.type === 'race_loser_cleaned');
    expect(cleaned.length).toBe(1);
  });
});
