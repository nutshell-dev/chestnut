/**
 * LLMOrchestrator call/hedge regression tests — Phase 896
 *
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
