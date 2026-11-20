import { legacyProviderFactory } from './provider-test-fixtures.js';
/**
 * Hedge state machine cluster (phase 991)
 * 4 sub-fix reverse tests: B.2 drain abort guard + B.3 double-fail providerStates + B.4 skippedCount + B.6 reset event
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLMAllProvidersFailedError,
} from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMContextExceededError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type {
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
type ProviderAdapter = llmProviderCall.ProviderAdapter;
type ProviderStreamChunk = llmProviderCall.ProviderStreamChunk;
import type { ProviderConnection } from './provider-test-fixtures.js';
import type { LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';
import { internalsOf, providerStatesOf, replaceProviderStates } from './test-internals.js';

/** Named real-timer tracks make each state-machine race ordering explicit. */
const HEDGE_FAST_CALL_DELAY_MS = 50;
const HEDGE_SLOW_CALL_DELAY_MS = 500;
const HEDGE_ERROR_STREAM_DELAY_MS = 20;
const HEDGE_ABORT_STREAM_DELAY_MS = 30;
const HEDGE_FAST_FAIL_CALL_DELAY_MS = 5;
const HEDGE_ABORT_RACE_DELAY_MS = 100;
const HEDGE_POST_FAILURE_STREAM_DELAY_MS = 50;

function createMockProvider(
  name: string,
  opts: {
    streamChunks?: ProviderStreamChunk[];
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
  };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const findAdapter = (cfg: ProviderConnection) => {
    if (cfg.providerId === primary.name) return primary;
    return fallbacks.find(fb => fb.name === cfg.providerId) ?? primary;
  };
  const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
    primary: { providerId: primary.name, authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' }, model: primary.model, apiFormat: 'anthropic' as const },
    fallbacks: fallbacks.map(fb => ({ providerId: fb.name, authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' }, model: fb.model, apiFormat: 'anthropic' as const })),
    maxAttempts: 1,
    retryDelayMs: 0, // 禁用重试等待，保持状态机竞态确定。
    events: noopSink,
    providerFactory: legacyProviderFactory((cfg) => findAdapter(cfg)),
  });
  return service;
}

function forceProviderWaiting(service: LLMOrchestratorImpl, index: number, cause: 'transient' | 'permanent' | 'rate_limit') {
  const now = Date.now();
  replaceProviderStates(service, [{
    providerId: internalsOf(service).providerRuntime.providerIds()[index],
    status: 'waiting',
    retryAt: now + 60_000,
    lastError: { class: cause, at: now, message: 'forced provider failure' },
    consecutiveFailures: 1,
  }]);
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



describe('hedge state machine cluster (phase 991)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('typed context candidate failover', () => {
    it('A-error typed context does not abort a B track that can still succeed', async () => {
      const providerError = new LLMContextExceededError('primary', 413, 'too large');
      const primary = createMockProvider('primary', { streamError: providerError });
      const fallback = createMockProvider('fb1', { callDelayMs: HEDGE_FAST_CALL_DELAY_MS });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');
      const emitted = attachEventSpy(service);
      const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);

      const chunks: LLMStreamChunk[] = [];
      for await (const chunk of service.stream({ messages: [] })) chunks.push(chunk);

      expect(chunks).toEqual([
        { type: 'text_delta', delta: 'Response from fb1' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
      expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
      expect(emitted.some(e => e.type === 'hedge_fallback_committed')).toBe(true);
      expect(emitted).toContainEqual(expect.objectContaining({
        type: 'call_attempt_result', provider: 'primary', outcome: 'failure', errorClass: 'context_exceeded',
      }));
      expect(emitted.some(e => e.type === 'call_selection' && e.outcome === 'selected' && e.provider === 'fb1')).toBe(true);
      expect(emitted.some(e => e.type === 'call_selection' && e.outcome === 'exhausted')).toBe(false);
    });

    it('A post-content typed context resets and commits the still-running B track', async () => {
      const providerError = new LLMContextExceededError('primary', 413, 'too large');
      const primary = createMockProvider('primary', {
        streamChunks: [{ type: 'text_delta', delta: 'partial' }],
        streamError: providerError,
        streamErrorAfter: 1,
      });
      const fallback = createMockProvider('fb1', { callDelayMs: HEDGE_FAST_CALL_DELAY_MS });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');
      const emitted = attachEventSpy(service);
      const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);
      const chunks: LLMStreamChunk[] = [];

      for await (const chunk of service.stream({ messages: [] })) chunks.push(chunk);

      expect(chunks).toEqual([
        { type: 'text_delta', delta: 'partial' },
        { type: 'reset', provider: 'primary' },
        { type: 'text_delta', delta: 'Response from fb1' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
      expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
      expect(emitted).toContainEqual(expect.objectContaining({
        type: 'call_attempt_result', provider: 'primary', outcome: 'failure', errorClass: 'context_exceeded',
      }));
      expect(emitted.some(event =>
        event.type === 'call_selection' && event.outcome === 'selected' && event.provider === 'fb1'
      )).toBe(true);
    });

    it('B-error then A typed context preserves both failures in a mixed aggregate', async () => {
      const providerError = new LLMContextExceededError('primary', 413, 'too large');
      const primary = createMockProvider('primary', {
        streamDelayMs: HEDGE_ERROR_STREAM_DELAY_MS,
        streamError: providerError,
      });
      const fallback = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('offline')),
      });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');

      let caught: unknown;
      try {
        for await (const _chunk of service.stream({ messages: [] })) { /* drain */ }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LLMAllProvidersFailedError);
      const aggregate = caught as LLMAllProvidersFailedError;
      expect(aggregate.failures.map(failure => failure.provider)).toEqual(['primary', 'fb1']);
      expect(aggregate.failures[0].error).toBe(providerError);
      expect(aggregate.evidence.map(failure => failure.family)).toEqual(['context_exceeded', 'transient']);
    });
  });

  describe('B.2 drain post-abort guard', () => {
    it('A-win drain loop throws AbortError when user signals abort mid-drain', async () => {
      const abortCtrl = new AbortController();
      const primary = createMockProvider('primary', {
        streamChunks: [
          { type: 'text_delta', delta: 'c1' },
          { type: 'text_delta', delta: 'c2' },
          { type: 'text_delta', delta: 'c3' },
          { type: 'text_delta', delta: 'c4' },
          { type: 'done', stopReason: 'end_turn' },
        ],
        streamDelayMs: HEDGE_ERROR_STREAM_DELAY_MS,
      });
      const fallback = createMockProvider('fb1', {
        callResponse: {
          content: [{ type: 'text', text: 'fb response' }],
          stop_reason: 'end_turn',
        },
        callDelayMs: HEDGE_SLOW_CALL_DELAY_MS,
      });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');
      const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);

      const chunks: LLMStreamChunk[] = [];
      let caught: Error | undefined;
      try {
        for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal })) {
          chunks.push(c);
          if (chunks.length === 2) {
            abortCtrl.abort();
          }
        }
      } catch (e) {
        caught = e as Error;
      }

      // AbortError propagated to consumer (not silent EOF)
      expect(caught).toBeDefined();
      expect(caught!.name).toBe('AbortError');
      // chunk 4 and done should NOT be yielded because abort guard breaks drain
      expect(chunks.some(ch => (ch as any).delta === 'c4')).toBe(false);
      expect(chunks.some(ch => ch.type === 'done')).toBe(false);
      // user abort is not a provider failure
      expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
    });

    it('B-error-then-A-win drain loop throws AbortError when user aborts mid-drain', async () => {
      const abortCtrl = new AbortController();
      const primary = createMockProvider('primary', {
        streamChunks: [
          { type: 'text_delta', delta: 'c1' },
          { type: 'text_delta', delta: 'c2' },
          { type: 'text_delta', delta: 'c3' },
        ],
        streamDelayMs: HEDGE_ABORT_STREAM_DELAY_MS,
      });
      const fallback = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
        callDelayMs: HEDGE_FAST_FAIL_CALL_DELAY_MS,
      });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');

      const chunks: LLMStreamChunk[] = [];
      let caught: Error | undefined;
      try {
        for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal })) {
          chunks.push(c);
          if (chunks.length === 1) {
            abortCtrl.abort();
          }
        }
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.name).toBe('AbortError');
      expect(chunks.some(ch => (ch as any).delta === 'c3')).toBe(false);
    });

    it('does not fallback when user aborts during hedge race', async () => {
      const abortCtrl = new AbortController();
      const primary = createMockProvider('primary', {
        streamDelayMs: HEDGE_ABORT_RACE_DELAY_MS,
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      });
      const fallback = createMockProvider('fb1', {
        callDelayMs: HEDGE_ABORT_RACE_DELAY_MS,
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');
      const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);

      // Abort mid-race, before either 100ms track settles
      const ABORT_DELAY_MS = 10; // derive: enough for track promise to start but not resolve (>0, <100ms track delay)
      const abortTimer = setTimeout(() => abortCtrl.abort(), ABORT_DELAY_MS);

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal })) {}
      }).rejects.toThrowError(/Execution aborted/);

      clearTimeout(abortTimer);

      // user abort must not be wrapped as all-providers-failed
      expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
    });

    it('does not record provider failure when user aborts during A-win drain catch', async () => {
      const abortCtrl = new AbortController();
      const primary: ProviderAdapter = {
        name: 'primary',
        model: 'mock-model',
        async call() {
          return { content: [{ type: 'text', text: 'primary response' }], stop_reason: 'end_turn' };
        },
        async *stream(streamOpts?: { signal?: AbortSignal }) {
          yield { type: 'text_delta', delta: 'c1' };
          await new Promise<void>((resolve) => {
            const NETWORK_ERROR_DELAY_MS = 50; // derive: >ABORT_DELAY_MS(10ms) so consumer aborts while stream is still "in-flight"
            const timer = setTimeout(resolve, NETWORK_ERROR_DELAY_MS);
            streamOpts?.signal?.addEventListener('abort', () => clearTimeout(timer));
          });
          // Throw a real provider error even though user may have aborted
          throw new LLMNetworkError('primary', new Error('ECONNRESET'));
        },
      };
      const fallback = createMockProvider('fb1', {
        callResponse: {
          content: [{ type: 'text', text: 'fb response' }],
          stop_reason: 'end_turn',
        },
        callDelayMs: HEDGE_SLOW_CALL_DELAY_MS,
      });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');
      const events = attachEventSpy(service);
      const primaryStateBefore = structuredClone(providerStatesOf(service)[0]);

      const chunks: LLMStreamChunk[] = [];
      let caught: Error | undefined;
      try {
        for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal })) {
          chunks.push(c);
          if (chunks.length === 1) {
            abortCtrl.abort();
          }
        }
      } catch (e) {
        caught = e as Error;
      }

      // user abort takes priority over the provider error
      expect(caught).toBeDefined();
      expect(caught!.name).toBe('AbortError');
      // provider recovery state must not change for user abort
      expect(providerStatesOf(service)[0]).toEqual(primaryStateBefore);
      // stream_reset must not be emitted for user abort
      expect(events.some(e => e.type === 'stream_reset')).toBe(false);
      expect(chunks.some(c => c.type === 'reset')).toBe(false);
    });
  });

  describe('B.3 双失败 providerStates failure accounting', () => {
    it('A-error + B-error 双失败 → primary provider state records the error class', async () => {
      const primary = createMockProvider('primary', {
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      });
      const fb1 = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      });
      const service = createOrchestrator(primary, [fb1]);
      forceProviderWaiting(service, 0, 'transient');

      const failuresBefore = providerStatesOf(service)[0].consecutiveFailures;

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      }).rejects.toThrow(LLMAllProvidersFailedError);

      const primaryState = providerStatesOf(service)[0];
      expect(primaryState.status).toBe('waiting');
      expect(primaryState.retryAt).toEqual(expect.any(Number));
      expect(primaryState.consecutiveFailures).toBe(failuresBefore + 1);
      expect(primaryState.lastError.class).toBe('transient');
      expect(primaryState.lastError.message).toContain('ECONNREFUSED');
    });

    it('B-error + A-error 双失败 → primary provider state records the error class', async () => {
      const primary = createMockProvider('primary', {
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
        streamDelayMs: HEDGE_POST_FAILURE_STREAM_DELAY_MS,
      });
      const fb1 = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      });
      const service = createOrchestrator(primary, [fb1]);
      forceProviderWaiting(service, 0, 'transient');

      const failuresBefore = providerStatesOf(service)[0].consecutiveFailures;

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      }).rejects.toThrow(LLMAllProvidersFailedError);

      const primaryState = providerStatesOf(service)[0];
      expect(primaryState.status).toBe('waiting');
      expect(primaryState.retryAt).toEqual(expect.any(Number));
      expect(primaryState.consecutiveFailures).toBe(failuresBefore + 1);
      expect(primaryState.lastError.class).toBe('transient');
      expect(primaryState.lastError.message).toContain('ECONNREFUSED');
    });
  });

  describe('B.4 contextExceededCount accounting', () => {
    it('1 waiting primary + 2 context_exceeded (3 total) → throws aggregate context failure', async () => {
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
      // primary waiting with permanent cause → no hedge → non-hedge stream loop
      forceProviderWaiting(service, 0, 'permanent');

      let thrown: Error | undefined;
      try {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown).toBeInstanceOf(LLMAllProvidersFailedError);
      const aggregate = thrown as LLMAllProvidersFailedError;
      expect(aggregate.failures.map(failure => failure.provider)).toEqual(['fb1', 'fb2']);
      expect(aggregate.evidence.every(failure => failure.family === 'context_exceeded')).toBe(true);
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
        callDelayMs: HEDGE_SLOW_CALL_DELAY_MS,
      });
      const service = createOrchestrator(primary, [fallback]);
      forceProviderWaiting(service, 0, 'transient');
      const events = attachEventSpy(service);

      const chunks: LLMStreamChunk[] = [];
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
