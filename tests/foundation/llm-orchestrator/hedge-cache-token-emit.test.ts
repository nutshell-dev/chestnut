/**
 * hedge cache token emit (phase 1169 α-4)
 * Reverse test 3项: fallback_committed 含 cache cols / primary_recovered 可选 / non-Anthropic absent
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError } from '../../../src/foundation/llm-orchestrator/errors.js';
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

describe('hedge cache token emit (phase 1169 α-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverse 1: hedge_fallback_committed event includes cache cols when provider returns cache_*', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      streamDelayMs: 100,
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 80,
        },
      },
      callDelayMs: 50,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    const committed = events.find((e) => e.type === 'hedge_fallback_committed');
    expect(committed).toBeDefined();
    expect((committed as any).cacheCreationInputTokens).toBe(20);
    expect((committed as any).cacheReadInputTokens).toBe(80);

    // done chunk should also carry cache tokens through wrapResponseAsStream
    const doneChunk = chunks.find((c) => c.type === 'done');
    expect(doneChunk).toBeDefined();
    expect((doneChunk as any).usage?.cacheCreationInputTokens).toBe(20);
    expect((doneChunk as any).usage?.cacheReadInputTokens).toBe(80);
  });

  it('reverse 2: A-error wait B path includes cache cols in hedge_fallback_committed', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 150,
        },
      },
      callDelayMs: 50,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    const committed = events.find((e) => e.type === 'hedge_fallback_committed');
    expect(committed).toBeDefined();
    expect((committed as any).cacheCreationInputTokens).toBe(50);
    expect((committed as any).cacheReadInputTokens).toBe(150);
  });

  it('reverse 3: non-Anthropic provider 0 cache_* → emit absent cache cols (undefined)', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      streamDelayMs: 100,
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      callDelayMs: 50,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    const committed = events.find((e) => e.type === 'hedge_fallback_committed');
    expect(committed).toBeDefined();
    expect((committed as any).cacheCreationInputTokens).toBeUndefined();
    expect((committed as any).cacheReadInputTokens).toBeUndefined();

    const doneChunk = chunks.find((c) => c.type === 'done');
    expect(doneChunk).toBeDefined();
    expect((doneChunk as any).usage?.cacheCreationInputTokens).toBeUndefined();
    expect((doneChunk as any).usage?.cacheReadInputTokens).toBeUndefined();
  });
});
