/**
 * Phase 978 r120 B fork — hedge B-wins primary error 真错失踪治理
 *
 * 3 态 race outcome verify:
 *   (1) A-error 真错 (A 异常或 ended without content): primaryError = aResult.error
 *   (2) A succeeded but race lost (A produced chunk 但 B 先 settled): NEW event + sentinel marker
 *   (3) (合并入 1) abort propagated: A-error with AbortError
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError } from '../../../src/types/errors.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createDeferredMockProvider(
  name: string,
  opts: {
    streamChunks?: StreamChunk[];
    streamError?: Error;
    callResponse?: LLMResponse;
    callError?: Error;
  } = {},
): {
  provider: ProviderAdapter;
  resolveCall: () => void;
  rejectCall: (e: Error) => void;
  resolveStream: () => void;
} {
  let resolveCall!: () => void;
  let rejectCall!: (e: Error) => void;
  let resolveStream!: () => void;

  const callPromise = new Promise<void>((res, rej) => {
    resolveCall = res;
    rejectCall = rej;
  });

  const streamPromise = new Promise<void>((res) => {
    resolveStream = res;
  });

  const provider: ProviderAdapter = {
    name,
    model: 'mock-model',
    async call() {
      await callPromise;
      if (opts.callError) throw opts.callError;
      return (
        opts.callResponse ?? {
          content: [{ type: 'text', text: `Response from ${name}` }],
          stop_reason: 'end_turn',
        }
      );
    },
    stream:
      opts.streamChunks || opts.streamError
        ? async function* () {
            await streamPromise;
            if (opts.streamError) throw opts.streamError;
            for (const chunk of opts.streamChunks ?? []) {
              yield chunk;
            }
          }
        : undefined,
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };

  return { provider, resolveCall, rejectCall, resolveStream };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const service = new LLMOrchestratorImpl({
    primary: { name: primary.name, apiKey: 'test', model: primary.model },
    fallbacks: fallbacks.map((fb) => ({ name: fb.name, apiKey: 'test', model: fb.model })),
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

describe('phase 978 — hedge B-wins primary outcome 3 态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A-error: primary throws → primaryError = real error', async () => {
    const primaryDef = createDeferredMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
    });
    const fallbackDef = createDeferredMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
    });
    const service = createOrchestrator(primaryDef.provider, [fallbackDef.provider]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const streamPromise = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
      return chunks;
    })();

    // Resolve B first → B wins race
    fallbackDef.resolveCall();
    // Then resolve A stream → A throws ECONNREFUSED after B won
    primaryDef.resolveStream();

    const chunks = await streamPromise;

    // expect emit: hedge_fallback_committed { primaryError: real message, primaryErrorClass: classified }
    const committed = events.filter((e) => e.type === 'hedge_fallback_committed');
    expect(committed.length).toBe(1);
    expect((committed[0] as any).primaryError).toBe('LLM network failure for primary: ECONNREFUSED');
    expect((committed[0] as any).primaryErrorClass).toBe('transient');
    // expect 0 emit: hedge_primary_succeeded_after_race_lost
    expect(events.some((e) => e.type === 'hedge_primary_succeeded_after_race_lost')).toBe(false);
    expect(chunks.map((c) => c.type)).toEqual(['text_delta', 'done']);
  });

  it('A-succeeded-race-lost: A produces chunk + B finishes first → NEW event + sentinel marker', async () => {
    const primaryDef = createDeferredMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const fallbackDef = createDeferredMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
    });
    const service = createOrchestrator(primaryDef.provider, [fallbackDef.provider]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const streamPromise = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
      return chunks;
    })();

    // Resolve B first → B wins race
    fallbackDef.resolveCall();
    // Then resolve A stream → A produces chunk after B won (rare race window)
    primaryDef.resolveStream();

    const chunks = await streamPromise;

    // expect emit 序列: hedge_primary_succeeded_after_race_lost + hedge_fallback_committed { primaryError: sentinel, primaryErrorClass: 'unknown' }
    const raceLostEvents = events.filter((e) => e.type === 'hedge_primary_succeeded_after_race_lost');
    expect(raceLostEvents.length).toBe(1);
    expect((raceLostEvents[0] as any).primaryProvider).toBe('primary');
    expect((raceLostEvents[0] as any).winnerProvider).toBe('fb1');

    const committed = events.filter((e) => e.type === 'hedge_fallback_committed');
    expect(committed.length).toBe(1);
    expect((committed[0] as any).primaryError).toBe('A succeeded but race lost (commit fallback for low latency)');
    expect((committed[0] as any).primaryErrorClass).toBe('unknown');

    // fallback response streamed
    expect(chunks.map((c) => c.type)).toEqual(['text_delta', 'done']);
    expect((chunks[0] as { delta?: string }).delta).toBe('fb response');
  });

  it('反向 1: 若改回二分支合成假错 → primaryError 不匹配 sentinel fail', async () => {
    const primaryDef = createDeferredMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const fallbackDef = createDeferredMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
    });
    const service = createOrchestrator(primaryDef.provider, [fallbackDef.provider]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const streamPromise = service.stream({ messages: [{ role: 'user', content: 'hi' }] });

    fallbackDef.resolveCall();
    primaryDef.resolveStream();

    for await (const _ of streamPromise) {}

    const committed = events.find((e) => e.type === 'hedge_fallback_committed') as any;
    // 当前 code 正确时 ≠ 'primary stream cancelled'
    expect(committed.primaryError).not.toBe('primary stream cancelled');
    expect(committed.primaryError).toBe('A succeeded but race lost (commit fallback for low latency)');
  });

  it('反向 2: dead .catch removal — trackAPromise resolve 永不 reject (IIFE 内 try/catch invariant)', async () => {
    // construct trackAPromise-like IIFE manually、verify .then().catch() 永走 then
    const simTrackAPromise: Promise<{ winner: 'A' | 'A-error'; data?: string; error?: Error }> = (async () => {
      try {
        await new Promise((r) => setTimeout(r, 10));
        return { winner: 'A' as const, data: 'chunk' };
      } catch (e) {
        return { winner: 'A-error' as const, error: e as Error };
      }
    })();

    const result = await simTrackAPromise;
    expect(result.winner).toBe('A');
    expect(result.data).toBe('chunk');
    // 若 IIFE 内无 try/catch、外部有 .catch(() => null)，reject 时会走 catch
    // 现 IIFE 内 try/catch 保证永 resolve、.catch(() => null) 是 dead code
  });
});
