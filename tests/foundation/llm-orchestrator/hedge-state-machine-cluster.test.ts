/**
 * Hedge state machine cluster (phase 991)
 * 4 sub-fix reverse tests: B.2 drain abort guard + B.3 double-fail onFailure + B.4 skippedCount + B.6 reset event
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import {
  LLMNetworkError,
  LLMAllProvidersFailedError,
} from '../../../src/foundation/llm-orchestrator/errors.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockProvider(
  name: string,
  opts: {
    streamChunks?: StreamChunk[];
    streamError?: Error;
    streamErrorAfter?: number;
    streamDelayMs?: number;
    callResponse?: any;
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
    stream: opts.streamChunks || opts.streamError || opts.streamErrorAfter !== undefined || opts.streamDelayMs
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
          if (opts.streamError && !opts.streamChunks) throw opts.streamError;
          const chunks = opts.streamChunks ?? [];
          let count = 0;
          for (const chunk of chunks) {
            yield chunk;
            count++;
            if (opts.streamErrorAfter !== undefined && count >= opts.streamErrorAfter) {
              throw opts.streamError ?? new Error('stream error');
            }
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
    primary: { name: primary.name, apiKey: 'test', model: primary.model },
    fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model })),
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

describe('hedge state machine cluster (phase 991)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('B.2 drain post-abort guard', () => {
    it('A-win drain loop breaks when user signals abort mid-drain', async () => {
      const abortCtrl = new AbortController();
      const primary = createMockProvider('primary', {
        streamChunks: [
          { type: 'text_delta', delta: 'c1' },
          { type: 'text_delta', delta: 'c2' },
          { type: 'text_delta', delta: 'c3' },
          { type: 'text_delta', delta: 'c4' },
          { type: 'done', stopReason: 'end_turn' },
        ],
        streamDelayMs: 20,
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

      const chunks: StreamChunk[] = [];
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal })) {
        chunks.push(c);
        if (chunks.length === 2) {
          abortCtrl.abort();
        }
      }

      // first chunk + at most one more before abort signal propagates
      expect(chunks.length).toBeLessThanOrEqual(3);
      // chunk 4 and done should NOT be yielded because abort guard breaks drain
      expect(chunks.some(ch => (ch as any).delta === 'c4')).toBe(false);
      expect(chunks.some(ch => ch.type === 'done')).toBe(false);
    });
  });

  describe('B.3 双失败 breakers[0] onFailure', () => {
    it('A-error + B-error 双失败 → breakers[0].onFailure called with primary error class', async () => {
      const primary = createMockProvider('primary', {
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      });
      const fb1 = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      });
      const service = createOrchestrator(primary, [fb1]);
      forceBreakerOpen(service, 0, 'transient');

      const breaker = (service as any).breakers[0] as CircuitBreaker;
      const onFailureSpy = vi.spyOn(breaker, 'onFailure');

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      }).rejects.toThrow(LLMAllProvidersFailedError);

      expect(onFailureSpy).toHaveBeenCalledTimes(1);
      expect(onFailureSpy).toHaveBeenCalledWith('transient');
    });

    it('B-error + A-error 双失败 → breakers[0].onFailure called with primary error class', async () => {
      const primary = createMockProvider('primary', {
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
        streamDelayMs: 50,
      });
      const fb1 = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      });
      const service = createOrchestrator(primary, [fb1]);
      forceBreakerOpen(service, 0, 'transient');

      const breaker = (service as any).breakers[0] as CircuitBreaker;
      const onFailureSpy = vi.spyOn(breaker, 'onFailure');

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      }).rejects.toThrow(LLMAllProvidersFailedError);

      expect(onFailureSpy).toHaveBeenCalledTimes(1);
      expect(onFailureSpy).toHaveBeenCalledWith('transient');
    });
  });

  describe('B.4 contextExceededCount accounting', () => {
    it('1 breaker-open + 2 context_exceeded (3 total) → throws context-exceeded user message', async () => {
      const primary = createMockProvider('primary', {
        streamChunks: [{ type: 'text_delta', delta: 'ok' }],
      });
      const fb1 = createMockProvider('fb1', {
        streamChunks: [
          { type: 'done', stopReason: 'model_context_window_exceeded' },
        ],
      });
      const fb2 = createMockProvider('fb2', {
        streamChunks: [
          { type: 'done', stopReason: 'context_length_exceeded' },
        ],
      });
      const service = createOrchestrator(primary, [fb1, fb2]);
      // primary breaker open with permanent cause → no hedge → non-hedge stream loop
      forceBreakerOpen(service, 0, 'permanent');

      let thrown: Error | undefined;
      try {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain('context_window_exceeded');
      expect(thrown!.message).toContain('All 2 providers exhausted');
      expect(thrown).not.toBeInstanceOf(LLMAllProvidersFailedError);
    });
  });

  describe('B.6 hedge drain catch reset event', () => {
    it('post-first-chunk failure emits stream_reset event + yields reset chunk + throws', async () => {
      const drainErr = new LLMNetworkError('primary', new Error('ECONNRESET'));
      const primary = createMockProvider('primary', {
        streamChunks: [
          { type: 'text_delta', delta: 'hello' },
          { type: 'text_delta', delta: ' world' },
        ],
        streamErrorAfter: 1, // throw after yielding 1 chunk (post-first-chunk)
        streamError: drainErr,
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
      let caught: Error | undefined;
      try {
        for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          chunks.push(c);
        }
      } catch (e) {
        caught = e as Error;
      }

      // first chunk yielded before drain throws
      expect(chunks.some(c => c.type === 'text_delta' && (c as any).delta === 'hello')).toBe(true);

      // error rethrown
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('ECONNRESET');

      // audit event emitted
      expect(events.some(e => e.type === 'hedge_primary_post_first_chunk_failure')).toBe(true);

      // B.6: stream_reset event emitted
      const resetEvent = events.find(e => e.type === 'stream_reset');
      expect(resetEvent).toBeDefined();
      expect((resetEvent as any).provider).toBe('primary');

      // B.6: reset chunk yielded
      expect(chunks.some(c => c.type === 'reset' && (c as any).provider === 'primary')).toBe(true);
    });
  });
});
