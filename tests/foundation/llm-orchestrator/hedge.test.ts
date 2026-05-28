/**
 * LLMOrchestrator hedge mode tests
 * Phase 737 Step F — 2-track hedge on breaker open
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import {
  LLMNetworkError,
  LLMAuthError,
  LLMRateLimitError,
  LLMAllProvidersFailedError,
} from '../../../src/foundation/llm-orchestrator/errors.js';
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
  // Force open by calling onFailure enough times (threshold = 1)
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

describe('LLMOrchestratorImpl hedge mode (Phase 737)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hedge_primary_recovered: primary first chunk wins, breaker auto-close', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
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

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(true);
    expect(events.some((e) => e.type === 'hedge_primary_recovered')).toBe(true);
    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'hello' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(service.getProviderInfo()?.name).toBe('primary');
    expect((service as any).breakers[0].getOpenCause()).toBeNull();
  });

  it('hedge_fallback_committed: primary slow/fail, fallback wins, wrap as stream', async () => {
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

    expect(events.some((e) => e.type === 'hedge_started')).toBe(true);
    expect(events.some((e) => e.type === 'hedge_fallback_committed')).toBe(true);
    expect(chunks.map(c => c.type)).toEqual(['text_delta', 'done']);
    expect((chunks[0] as { delta?: string }).delta).toBe('fb response');
    expect(service.getProviderInfo()?.name).toBe('fb1');
  });

  it('hedge double fail: primary error + all fallbacks fail → throw LLMAllProvidersFailedError', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
    });
    const fb1 = createMockProvider('fb1', {
      callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
    });
    const fb2 = createMockProvider('fb2', {
      callError: new LLMNetworkError('fb2', new Error('ECONNREFUSED')),
    });
    const service = createOrchestrator(primary, [fb1, fb2]);
    forceBreakerOpen(service, 0, 'transient');

    await expect(async () => {
      for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
    }).rejects.toThrow(LLMAllProvidersFailedError);
  });

  it('hedge gate: breaker open with permanent cause → no hedge / sequential failover', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMAuthError('primary', 401),
    });
    const fallback = createMockProvider('fb1', {
      streamChunks: [
        { type: 'text_delta', delta: 'fb' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'permanent');
    const events = attachEventSpy(service);

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(false);
    expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'fb')).toBe(true);
  });

  it('hedge gate: breaker open with rate_limit cause → no hedge', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMRateLimitError('primary'),
    });
    const fallback = createMockProvider('fb1', {
      streamChunks: [
        { type: 'text_delta', delta: 'fb' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'rate_limit');
    const events = attachEventSpy(service);

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(false);
    expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'fb')).toBe(true);
  });

  it('provider_attempt_failed payload contains errorClass + userActionHint', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMAuthError('primary', 401, 'invalid api key'),
    });
    const fb1 = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      },
    });
    const service = createOrchestrator(primary, [fb1]);
    // breaker closed → sequential failover path
    const events = attachEventSpy(service);

    await (async () => {
      for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
    })().catch(() => {});

    const failedEvent = events.find((e) => e.type === 'provider_attempt_failed' && (e as any).provider === 'primary');
    expect(failedEvent).toBeDefined();
    expect((failedEvent as any).errorClass).toBe('permanent');
    expect((failedEvent as any).userActionHint).toBe('rotate_api_key');
  });
});
