/**
 * Hedge cleanup invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - hedge-post-first-chunk-failure.test.ts
 *  - hedge-double-fail-generator-cleanup.test.ts
 *  - hedge-bwins-cleanup.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type {
  ProviderAdapter,
  ProviderConfig,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';



/**
 * Hedge drain post-first-chunk failure — reverse test for phase 903 B2
 *
 * When primary wins (first chunk) but drain throws mid-stream,
 * breaker.onFailure must be called + audit event emitted + error rethrown.
 */
describe('hedge-post-first-chunk-failure', () => {
  function createMockProvider(
    name: string,
    opts: {
      streamChunks?: StreamChunk[];
      streamError?: Error;
      streamErrorAfter?: number; // throw after N chunks
      callResponse?: any;
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
    const findAdapter = (cfg: ProviderConfig) => {
      if (cfg.name === primary.name) return primary;
      return fallbacks.find(fb => fb.name === cfg.name) ?? primary;
    };
    const service = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, apiFormat: 'anthropic' as const })),
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      createAnthropicAdapter: (cfg) => findAdapter(cfg),
    });
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


  describe('LLMOrchestratorImpl hedge drain post-first-chunk failure (phase 903 B2)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      vi.clearAllMocks();
    });

    it('calls breaker.onFailure + emits audit event + rethrows when drain throws', async () => {
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

      // first chunk yielded before drain throws + reset chunk from B.6
      expect(chunks).toEqual([
        { type: 'text_delta', delta: 'hello' },
        { type: 'reset', provider: 'primary' },
      ]);

      // error rethrown
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('ECONNRESET');

      // breaker.onFailure called with the error class
      expect(onFailureSpy).toHaveBeenCalledTimes(1);
      expect(onFailureSpy).toHaveBeenCalledWith('transient');

      // audit event emitted
      const auditEvent = events.find(e => e.type === 'hedge_primary_post_first_chunk_failure');
      expect(auditEvent).toBeDefined();
      expect((auditEvent as any).provider).toBe('primary');
      expect((auditEvent as any).error).toBeDefined();
    });
  });
});

/**
 * hedge double-fail primaryIter generator cleanup (phase 984)
 * Reverse test 3项: 双失败 path 显式 cleanup generator / happy drain 不触发
 */
describe('hedge-double-fail-generator-cleanup', () => {
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
    const findAdapter = (cfg: ProviderConfig) => {
      if (cfg.name === primary.name) return primary;
      return fallbacks.find(fb => fb.name === cfg.name) ?? primary;
    };
    const service = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, apiFormat: 'anthropic' as const })),
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      createAnthropicAdapter: (cfg) => findAdapter(cfg),
    });
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

  describe('hedge double-fail primaryIter generator cleanup (phase 984)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('A-error → B-error 双失败 → primaryIter.return called', async () => {
      const primaryRaw = createMockProvider('primary', {
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      });
      const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

      const fb1 = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
        callDelayMs: 50,
      });
      const service = createOrchestrator(primary, [fb1]);
      forceBreakerOpen(service, 0, 'transient');

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      }).rejects.toThrow();

      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it('B-error → A-error 双失败 → primaryIter.return called', async () => {
      const primaryRaw = createMockProvider('primary', {
        streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
        streamDelayMs: 50,
      });
      const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

      const fb1 = createMockProvider('fb1', {
        callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      });
      const service = createOrchestrator(primary, [fb1]);
      forceBreakerOpen(service, 0, 'transient');

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
      }).rejects.toThrow();

      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it('A 胜 drain → primaryIter.return explicitly called in finally (phase 1374 sub-2)', async () => {
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
  });
});

/**
 * hedge B-wins primaryIter generator cleanup (phase 1169 α-3)
 * Reverse test 3项: B-wins path 显式 cleanup generator / throw silent / A-win 不触发
 */
describe('hedge-bwins-cleanup', () => {
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
    const findAdapter = (cfg: ProviderConfig) => {
      if (cfg.name === primary.name) return primary;
      return fallbacks.find(fb => fb.name === cfg.name) ?? primary;
    };
    const service = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, apiFormat: 'anthropic' as const })),
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      createAnthropicAdapter: (cfg) => findAdapter(cfg),
    });
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

  describe('hedge B-wins primaryIter generator cleanup (phase 1169 α-3)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('reverse 1: B wins → primaryIter.return() called once before cleanupSignals', async () => {
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
      const service = createOrchestrator(primary, [fb1]);
      forceBreakerOpen(service, 0, 'transient');

      const chunks: StreamChunk[] = [];
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }

      expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'fb response')).toBe(true);
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it('reverse 2: B wins + primaryIter.return throws → silent (no rethrow)', async () => {
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
      const service = createOrchestrator(primary, [fb1]);
      forceBreakerOpen(service, 0, 'transient');

      const chunks: StreamChunk[] = [];
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }

      expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'fb response')).toBe(true);
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it('reverse 3: A wins → primaryIter explicitly returned in finally (phase 1374 sub-2)', async () => {
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
  });
});
