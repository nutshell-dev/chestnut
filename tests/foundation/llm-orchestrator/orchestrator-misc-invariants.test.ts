/**
 * Orchestrator misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - breaker-open-transition-audit.test.ts
 *  - timeout-distinction.test.ts
 *  - all-providers-context-exceeded-emit.test.ts
 *  - merge-signals-cleanup.test.ts
 *  - llm-audit-sink-missing-events.test.ts
 *  - race-loser-cleanup.test.ts
 *  - hedge-cache-token-emit.test.ts
 *  - call-retry-provider-attempt-failed-emit.test.ts
 *  - call-retry-symmetry.test.ts
 *  - streaming-fallback-switched-emit.test.ts
 *  - user-action-hint-coverage.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError, LLMAuthError, getUserActionHint } from '../../../src/foundation/llm-orchestrator/errors.js';
import {
  LLMModelNotFoundError,
  LLMRateLimitError,
  LLMTimeoutError,
} from '../../../src/foundation/llm-provider/errors.js';
import { createLLMAuditSink } from '../../../src/assembly/llm-audit-sink.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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

/**
 * Phase 1013 E.1: breaker_opened transition fire audit
 */
describe('breaker-open-transition-audit', () => {
  /**
   * Default 失败 threshold for primary test fixtures（CircuitBreaker constructor 第 1 param）.
   * Derivation: 3 = 经验值 N 次连续失败 → open / 配 test 用例「N failures reaches threshold」
   * 验 N=threshold 触发 breaker_opened.
   */
  const DEFAULT_FAILURE_THRESHOLD = 3;

  /**
   * Default reset timeout for half-open transition（CircuitBreaker constructor 第 2 param）.
   * Derivation: 1000ms = 1s 给 test 简短 cool-down / 比 production default (~30s) 短 30× 加速 test /
   * 配「already open then additional onFailure」验证 cool-down 内不 re-fire.
   */
  const DEFAULT_RESET_TIMEOUT_MS = 1000;

  describe('phase 1013 E.1: breaker_opened transition fire', () => {
    it('N failures reaches threshold → onTransition fired with breaker_opened and failures count', () => {
      const onTransition = vi.fn();
      const cb = new CircuitBreaker(DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS, onTransition);

      cb.onFailure();
      cb.onFailure();
      cb.onFailure();

      expect(onTransition).toHaveBeenCalledTimes(1);
      expect(onTransition).toHaveBeenCalledWith('breaker_opened', DEFAULT_FAILURE_THRESHOLD);
    });

    it('half-open state then failure → onTransition fired with breaker_opened', () => {
      const onTransition = vi.fn();
      // resetTimeoutMs=0 is sentinel: half-open transition fires immediately
      const cb = new CircuitBreaker(DEFAULT_FAILURE_THRESHOLD, 0, onTransition);

      // Open the breaker
      cb.onFailure();
      cb.onFailure();
      cb.onFailure();
      onTransition.mockClear();

      // isOpen() should transition to half-open since resetTimeoutMs=0
      cb.isOpen(); // transitions to half-open, calls onTransition('breaker_half_open')
      onTransition.mockClear();

      // Failure in half-open should trigger breaker_opened again with failures count = threshold + 1
      cb.onFailure();
      expect(onTransition).toHaveBeenCalledTimes(1);
      expect(onTransition).toHaveBeenCalledWith('breaker_opened', DEFAULT_FAILURE_THRESHOLD + 1);
    });

    it('already open then additional onFailure does NOT re-fire breaker_opened', () => {
      // Per-it lower threshold: terse repro path（2 failures 即 open）
      const LOW_FAILURE_THRESHOLD = 2;
      const onTransition = vi.fn();
      const cb = new CircuitBreaker(LOW_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS, onTransition);

      cb.onFailure();
      cb.onFailure();
      expect(onTransition).toHaveBeenCalledTimes(1);
      onTransition.mockClear();

      cb.onFailure();
      expect(onTransition).not.toHaveBeenCalled();
    });
  });
});

/**
 * LLMOrchestrator timeout distinction tests
 * Phase 538 Step B — D.4
 */
describe('timeout-distinction', () => {
  /**
   * Mock chunk gap: set to 0 because the test does not depend on real wall-clock
   * intervals between chunks; only the arrival order matters for idle-timer reset.
   */
  const MOCK_CHUNK_GAP_MS = 0;

  const noopSink: LLMEventSink = { emit: () => {} };

  function createMockSink() {
    const emitted: LLMEvent[] = [];
    const sink: LLMEventSink = {
      emit(event: LLMEvent) { emitted.push(event); }
    };
    return { sink, emitted };
  }

  function createMockProvider(name: string, streamImpl?: () => AsyncGenerator<StreamChunk>, callImpl?: () => Promise<any>): ProviderAdapter {
    return {
      name,
      model: 'mock-model',
      async call() {
        if (callImpl) return callImpl();
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
    };
  }


  describe('LLMOrchestratorImpl timeout distinction (Phase 538)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('call() hardTimeoutMs 命中 → 抛 AbortError（不是无限等待）', async () => {
      const primary = createMockProvider('primary');
      // call 被 mock 为延迟 500ms 返回，但响应 signal abort
      primary.call = vi.fn(async (opts: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({ content: [{ type: 'text', text: 'late' }], stop_reason: 'end_turn' });
          }, 500);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
      });

      const service = new LLMOrchestratorImpl({
        primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = primary;

      await expect(
        service.call({ messages: [], hardTimeoutMs: 50 }),
      ).rejects.toThrow();

      // hard timeout 触发 → call 应该被 abort，不会等到 500ms 完成
      expect(primary.call).toHaveBeenCalledTimes(1);
      const passedOptions = (primary.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(passedOptions.signal).toBeDefined();
    });

    it('stream() streamIdleTimeoutMs 命中 → probe 失败 → 触发 idle_failover_triggered', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createMockProvider('primary', async function* (opts: { signal?: AbortSignal }) {
        yield { type: 'text_delta', delta: 'first' };
        // 之后长期不 yield chunk → idle timeout 触发
        // 但 generator 需要响应 signal abort，否则不会停止
        // Sleep duration derive: streamIdleTimeoutMs (50ms, line 127) × 100 safety = 5000ms;
        // mock must outlive idle timeout 才能让 idle 路径触发 abort.
        const MOCK_OUTLIVE_IDLE_MS = 50 * 100;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, MOCK_OUTLIVE_IDLE_MS);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
        yield { type: 'done' };
      }, async () => {
        // probe 失败（network/timeout）→ failover
        const err = new Error('probe timeout');
        err.name = 'AbortError';
        throw err;
      });

      const service = new LLMOrchestratorImpl({
        primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      (service as any).primary = primary;

      const chunks: StreamChunk[] = [];
      try {
        for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50, streamIdleProbeTimeoutMs: 50 })) {
          chunks.push(chunk);
        }
      } catch {
        // 预期抛错（所有 provider 失败）
      }

      // 至少收到第一个 chunk
      expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'first')).toBe(true);

      // probe attempted 事件应被 emit
      expect(emitted.some((e) => e.type === 'stream_idle_probe_attempted')).toBe(true);

      // idle_failover_triggered 事件应被 emit（probe 失败 → failover）
      const idleEvents = emitted.filter((e) => e.type === 'idle_failover_triggered');
      expect(idleEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('stream() chunk 到达时 reset idle timer → 正常流不被错杀', async () => {
      const primary = createMockProvider('primary', async function* () {
        yield { type: 'text_delta', delta: 'a' };
        await new Promise((resolve) => setTimeout(resolve, MOCK_CHUNK_GAP_MS));
        yield { type: 'text_delta', delta: 'b' };
        await new Promise((resolve) => setTimeout(resolve, MOCK_CHUNK_GAP_MS));
        yield { type: 'text_delta', delta: 'c' };
        yield { type: 'done' };
      });

      const service = new LLMOrchestratorImpl({
        primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = primary;

      const chunks: StreamChunk[] = [];
      for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 100 })) {
        chunks.push(chunk);
      }

      const textChunks = chunks.filter((c) => c.type === 'text_delta');
      expect(textChunks.map((c) => (c as any).delta)).toEqual(['a', 'b', 'c']);
    });


  });
});

describe('all-providers-context-exceeded-emit', () => {
  function createMockProvider(
    name: string,
    opts: {
      streamChunks?: StreamChunk[];
      streamError?: Error;
    } = {},
  ): ProviderAdapter {
    return {
      name,
      model: 'mock-model',
      async call() {
        return { content: [{ type: 'text', text: `Response from ${name}` }], stop_reason: 'end_turn' };
      },
      stream: opts.streamChunks || opts.streamError
        ? async function* () {
            if (opts.streamError) throw opts.streamError;
            for (const chunk of opts.streamChunks ?? []) {
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
      primary: { name: primary.name, apiKey: 'test', model: primary.model, maxTokens: 1024, apiFormat: 'anthropic' as const },
      fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, maxTokens: 1024, apiFormat: 'anthropic' as const })),
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


  describe('orchestrator all-providers context_exceeded emit (phase 1030 / audit-2026-05-18 NEW.P1.principle-2)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('all 2 providers context_exceeded → emit 1 + throw 1', async () => {
      const primary = createMockProvider('primary', {
        streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
      });
      const fb1 = createMockProvider('fb1', {
        streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
      });
      const service = createOrchestrator(primary, [fb1]);
      const events = attachEventSpy(service);

      await expect(async () => {
        const stream = service.stream({ messages: [], tools: [] });
        for await (const _chunk of stream) { /* drain */ }
      }).rejects.toThrow(/exhausted with context_window_exceeded/);

      const allCtxExceededEvents = events.filter((e) => e.type === 'all_providers_context_exceeded');
      expect(allCtxExceededEvents.length).toBe(1);
      expect(allCtxExceededEvents[0]).toMatchObject({
        totalAttempted: 2,
        skippedCount: 0,
      });
    });

    it('1 skipped + 1 attempted context_exceeded → totalAttempted=1 skippedCount=1', async () => {
      const primary = createMockProvider('primary', {
        streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
      });
      const fb1 = createMockProvider('fb1', {
        streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
      });
      const service = createOrchestrator(primary, [fb1]);
      const events = attachEventSpy(service);

      // Open primary's breaker so it gets skipped on next attempt
      // Use 'permanent' cause to avoid triggering hedge path (phase 737)
      forceBreakerOpen(service, 0, 'permanent');

      await expect(async () => {
        const stream = service.stream({ messages: [], tools: [] });
        for await (const _chunk of stream) { /* drain */ }
      }).rejects.toThrow(/exhausted with context_window_exceeded/);

      const allCtxExceededEvents = events.filter((e) => e.type === 'all_providers_context_exceeded');
      expect(allCtxExceededEvents.length).toBe(1);
      expect(allCtxExceededEvents[0]).toMatchObject({
        totalAttempted: 1,
        skippedCount: 1,
      });
    });

    it('mixed failure (1 context_exceeded + 1 other) → no emit (走 LLMAllProvidersFailedError path)', async () => {
      const primary = createMockProvider('primary', {
        streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
      });
      const fb1 = createMockProvider('fb1', {
        streamError: new Error('network failed'),
      });
      const service = createOrchestrator(primary, [fb1]);
      const events = attachEventSpy(service);

      await expect(async () => {
        const stream = service.stream({ messages: [], tools: [] });
        for await (const _chunk of stream) { /* drain */ }
      }).rejects.toThrow(/All LLM providers failed/);

      const allCtxExceededEvents = events.filter((e) => e.type === 'all_providers_context_exceeded');
      expect(allCtxExceededEvents.length).toBe(0);  // 不 emit (mixed cause)
    });
  });
});

/**
 * mergeSignals cleanup tests
 * Phase 538 Step B — D.5
 */
describe('merge-signals-cleanup', () => {
  const noopSink: LLMEventSink = { emit: () => {} };

  function createMockProvider(name: string): ProviderAdapter {
    return {
      name,
      model: 'mock-model',
      async call() {
        return {
          content: [{ type: 'text', text: `Response from ${name}` }],
          stop_reason: 'end_turn',
        };
      },
      stream: async function* () {
        yield { type: 'text_delta', delta: `Chunk from ${name}` };
        yield { type: 'done' };
      },
    };
  }


  class TrackedAbortSignal {
    aborted = false;
    reason: unknown = undefined;
    private listeners = new Set<(this: AbortSignal, ev: Event) => void>();

    addEventListener(
      type: string,
      listener: (this: AbortSignal, ev: Event) => void,
      _options?: AddEventListenerOptions,
    ): void {
      if (type === 'abort') this.listeners.add(listener);
    }

    removeEventListener(
      type: string,
      listener: (this: AbortSignal, ev: Event) => void,
    ): void {
      if (type === 'abort') this.listeners.delete(listener);
    }

    get listenerCount(): number {
      return this.listeners.size;
    }

    abort(reason?: unknown): void {
      this.aborted = true;
      this.reason = reason;
      for (const listener of Array.from(this.listeners)) {
        listener.call(this as unknown as AbortSignal, new Event('abort'));
      }
    }

    dispatchEvent(_event: Event): boolean {
      return true;
    }

    onabort: ((this: AbortSignal, ev: Event) => any) | null = null;
  }

  describe('mergeSignals cleanup (Phase 538)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('100 次成功 call 后 listener 不累积', async () => {
      const primary = createMockProvider('primary');
      const service = new LLMOrchestratorImpl({
        primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = primary;

      const signal = new TrackedAbortSignal() as unknown as AbortSignal;

      for (let i = 0; i < 100; i++) {
        await service.call({ messages: [], hardTimeoutMs: 5000, signal });
      }

      // 每次 call 都会 mergeSignals → add listener → cleanup 移除
      // 100 次后 listener 数应为 0
      expect((signal as unknown as TrackedAbortSignal).listenerCount).toBe(0);
    });

    it('abort 后 listener 不累积', async () => {
      const primary = createMockProvider('primary');
      primary.call = vi.fn(async (opts: { signal?: AbortSignal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({ content: [{ type: 'text', text: 'late' }], stop_reason: 'end_turn' });
          }, 10_000);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
      });

      const service = new LLMOrchestratorImpl({
        primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = primary;

      const signal = new TrackedAbortSignal() as unknown as AbortSignal;

      // 发起 call 但立即 abort
      const callPromise = service.call({ messages: [], hardTimeoutMs: 5000, signal });
      signal.abort({ type: 'user' });

      await expect(callPromise).rejects.toThrow();

      // abort 触发后 mergeSignals 的 cleanup 也应执行（通过 catch 路径）
      expect((signal as unknown as TrackedAbortSignal).listenerCount).toBe(0);
    });
  });
});

describe('llm-audit-sink-missing-events', () => {
  describe('llm-audit-sink phase 952 r118 K fork: 2 missing LLMEvent case (phase 882 S3 continuation)', () => {
    it('emits context_exceeded_failover audit row', () => {
      const writes: any[][] = [];
      const audit: AuditLog = { write: (...args) => writes.push(args) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
      const sink = createLLMAuditSink(audit);
      sink.emit({ type: 'context_exceeded_failover', provider: 'openai', stopReason: 'context_window_exceeded' });
      expect(writes.length).toBe(1);
      expect(writes[0][0]).toBe('llm_context_exceeded_failover');
      expect(writes[0]).toEqual(expect.arrayContaining(['provider=openai', 'stopReason=context_window_exceeded']));
    });

    it('emits permanent_skip_retry audit row', () => {
      const writes: any[][] = [];
      const audit: AuditLog = { write: (...args) => writes.push(args) , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any;
      const sink = createLLMAuditSink(audit);
      sink.emit({ type: 'permanent_skip_retry', provider: 'openai', attempt: 3, errorClass: 'permanent' });
      expect(writes.length).toBe(1);
      expect(writes[0][0]).toBe('llm_permanent_skip_retry');
      expect(writes[0]).toEqual(expect.arrayContaining(['provider=openai', 'attempt=3', 'errorClass=permanent']));
    });
  });
});

/**
 * Phase 1374 sub-2: race loser cleanup explicit finally
 * Reverse test ≥3项: mock 2 provider race + winner 后 loser stream 显式 close + audit emit
 */
describe('race-loser-cleanup', () => {
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
});

/**
 * hedge cache token emit (phase 1169 α-4)
 * Reverse test 3项: fallback_committed 含 cache cols / primary_recovered 可选 / non-Anthropic absent
 */
describe('hedge-cache-token-emit', () => {
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
});

/**
 * Phase 1324 C.2: orchestrator call() retry path provider_attempt_failed emit
 */
describe('call-retry-provider-attempt-failed-emit', () => {
  function createMockSink() {
    const emitted: LLMEvent[] = [];
    const sink: LLMEventSink = {
      emit(event: LLMEvent) { emitted.push(event); }
    };
    return { sink, emitted };
  }

  function createFailingProvider(name: string, failTimes: number): ProviderAdapter {
    let callCount = 0;
    return {
      name,
      model: 'mock-model',
      async call() {
        callCount++;
        if (callCount <= failTimes) {
          throw new Error(`provider error ${callCount}`);
        }
        return {
          content: [{ type: 'text', text: 'success' }],
          stop_reason: 'end_turn',
        } as LLMResponse;
      },
      async *stream() {
        yield { type: 'text_delta', delta: 'chunk' };
        yield { type: 'done' };
      },
    };
  }

  describe('phase 1324 C.2: call() retry path provider_attempt_failed emit', () => {
    it('3 retries all fail → provider_attempt_failed emitted 3 times + 1 retry_scheduled per retry', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createFailingProvider('primary', 999);
      const orchestrator = new LLMOrchestratorImpl({
        primary: { name: 'mock', apiKey: 'test', model: 'mock-model', apiFormat: 'anthropic' as const },
        maxAttempts: 3,
        retryDelayMs: 10,
        events: sink,
      });
      // Override primary with mock
      (orchestrator as any).primary = primary;
      (orchestrator as any).breakers = [new CircuitBreaker(5, 1000, () => {})];

      await expect(orchestrator.call({})).rejects.toThrow();

      const attemptFailedEvents = emitted.filter(e => e.type === 'provider_attempt_failed');
      expect(attemptFailedEvents.length).toBe(3);
      expect(attemptFailedEvents[0]).toMatchObject({
        type: 'provider_attempt_failed',
        provider: 'primary',
        attempt: 0,
        error: 'provider error 1',
      });
      expect(attemptFailedEvents[1]).toMatchObject({
        type: 'provider_attempt_failed',
        provider: 'primary',
        attempt: 1,
        error: 'provider error 2',
      });
      expect(attemptFailedEvents[2]).toMatchObject({
        type: 'provider_attempt_failed',
        provider: 'primary',
        attempt: 2,
        error: 'provider error 3',
      });

      // Each failed attempt (except last) triggers retry_scheduled
      const retryScheduledEvents = emitted.filter(e => e.type === 'retry_scheduled');
      expect(retryScheduledEvents.length).toBe(2);
    });

    it('1 fail then success → 1 provider_attempt_failed + 1 retry_scheduled', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createFailingProvider('primary', 1);
      const orchestrator = new LLMOrchestratorImpl({
        primary: { name: 'mock', apiKey: 'test', model: 'mock-model', apiFormat: 'anthropic' as const },
        maxAttempts: 3,
        retryDelayMs: 10,
        events: sink,
      });
      (orchestrator as any).primary = primary;
      (orchestrator as any).breakers = [new CircuitBreaker(5, 1000, () => {})];

      const result = await orchestrator.call({});
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'success' });

      const attemptFailedEvents = emitted.filter(e => e.type === 'provider_attempt_failed');
      expect(attemptFailedEvents.length).toBe(1);
      expect(attemptFailedEvents[0]).toMatchObject({
        type: 'provider_attempt_failed',
        provider: 'primary',
        attempt: 0,
      });

      const retryScheduledEvents = emitted.filter(e => e.type === 'retry_scheduled');
      expect(retryScheduledEvents.length).toBe(1);
    });

    it('provider_attempt_failed includes errorClass + userActionHint fields (parity with stream())', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createFailingProvider('primary', 1);
      const orchestrator = new LLMOrchestratorImpl({
        primary: { name: 'mock', apiKey: 'test', model: 'mock-model', apiFormat: 'anthropic' as const },
        maxAttempts: 2,
        retryDelayMs: 10,
        events: sink,
      });
      (orchestrator as any).primary = primary;
      (orchestrator as any).breakers = [new CircuitBreaker(5, 1000, () => {})];

      await orchestrator.call({});

      const attemptFailedEvents = emitted.filter(e => e.type === 'provider_attempt_failed');
      expect(attemptFailedEvents.length).toBe(1);
      expect(attemptFailedEvents[0]).toHaveProperty('errorClass');
      expect(attemptFailedEvents[0]).toHaveProperty('userActionHint');
    });
  });
});

/**
 * Phase 1374 sub-1: call() fallback retry symmetry
 * Reverse test ≥3项: fallback retry N attempts symmetric with primary + stream
 */
describe('call-retry-symmetry', () => {
  function createMockSink() {
    const emitted: LLMEvent[] = [];
    const sink: LLMEventSink = {
      emit(event: LLMEvent) { emitted.push(event); }
    };
    return { sink, emitted };
  }

  function createFailingProvider(name: string, failTimes: number): ProviderAdapter {
    let callCount = 0;
    return {
      name,
      model: 'mock-model',
      async call() {
        callCount++;
        if (callCount <= failTimes) {
          throw new Error(`provider error ${callCount}`);
        }
        return {
          content: [{ type: 'text', text: 'success' }],
          stop_reason: 'end_turn',
        } as LLMResponse;
      },
      async *stream() {
        yield { type: 'text_delta', delta: 'chunk' };
        yield { type: 'done' };
      },
    };
  }

  describe('phase 1374 sub-1: call() fallback retry symmetry', () => {
    it('fallback gets maxAttempts retry before exhausted (symmetric with primary)', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createFailingProvider('primary', 999);
      const fallback = createFailingProvider('fallback', 999);
      const orchestrator = new LLMOrchestratorImpl({
        primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
        fallbacks: [{ name: fallback.name, apiKey: 'test', model: fallback.model, apiFormat: 'anthropic' as const }],
        maxAttempts: 3,
        retryDelayMs: 10,
        events: sink,
      });
      (orchestrator as any).primary = primary;
      (orchestrator as any).fallbacks = [fallback];
      (orchestrator as any).breakers = [
        new CircuitBreaker(5, 1000, () => {}),
        new CircuitBreaker(5, 1000, () => {}),
      ];

      await expect(orchestrator.call({})).rejects.toThrow();

      const fallbackAttemptFailed = emitted.filter(
        e => e.type === 'provider_attempt_failed' && e.provider === 'fallback'
      );
      expect(fallbackAttemptFailed.length).toBe(3);
      expect(fallbackAttemptFailed[0]).toMatchObject({ attempt: 0 });
      expect(fallbackAttemptFailed[1]).toMatchObject({ attempt: 1 });
      expect(fallbackAttemptFailed[2]).toMatchObject({ attempt: 2 });

      const fallbackRetryScheduled = emitted.filter(
        e => e.type === 'retry_scheduled' && e.provider === 'fallback'
      );
      expect(fallbackRetryScheduled.length).toBe(2);
    });

    it('fallback retries then succeeds (symmetric pattern with primary)', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createFailingProvider('primary', 999);
      const fallback = createFailingProvider('fallback', 2);
      const orchestrator = new LLMOrchestratorImpl({
        primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
        fallbacks: [{ name: fallback.name, apiKey: 'test', model: fallback.model, apiFormat: 'anthropic' as const }],
        maxAttempts: 3,
        retryDelayMs: 10,
        events: sink,
      });
      (orchestrator as any).primary = primary;
      (orchestrator as any).fallbacks = [fallback];
      (orchestrator as any).breakers = [
        new CircuitBreaker(5, 1000, () => {}),
        new CircuitBreaker(5, 1000, () => {}),
      ];

      const result = await orchestrator.call({});
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'success' });

      const fallbackAttemptFailed = emitted.filter(
        e => e.type === 'provider_attempt_failed' && e.provider === 'fallback'
      );
      expect(fallbackAttemptFailed.length).toBe(2);

      const fallbackRetryScheduled = emitted.filter(
        e => e.type === 'retry_scheduled' && e.provider === 'fallback'
      );
      expect(fallbackRetryScheduled.length).toBe(2);
    });

    it('fallback permanent error skips retry (symmetric with primary)', async () => {
      const { sink, emitted } = createMockSink();
      const primary = createFailingProvider('primary', 999);
      const fallback: ProviderAdapter = {
        name: 'fallback',
        model: 'mock-model',
        async call() {
          throw new LLMAuthError('fallback', new Error('401 Unauthorized'));
        },
        async *stream() {
          yield { type: 'done' };
        },
      };
      const orchestrator = new LLMOrchestratorImpl({
        primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
        fallbacks: [{ name: fallback.name, apiKey: 'test', model: fallback.model, apiFormat: 'anthropic' as const }],
        maxAttempts: 3,
        retryDelayMs: 10,
        events: sink,
      });
      (orchestrator as any).primary = primary;
      (orchestrator as any).fallbacks = [fallback];
      (orchestrator as any).breakers = [
        new CircuitBreaker(5, 1000, () => {}),
        new CircuitBreaker(5, 1000, () => {}),
      ];

      await expect(orchestrator.call({})).rejects.toThrow();

      const fallbackAttemptFailed = emitted.filter(
        e => e.type === 'provider_attempt_failed' && e.provider === 'fallback'
      );
      // Only 1 attempt because permanent error skips retry
      expect(fallbackAttemptFailed.length).toBe(1);

      const permanentSkip = emitted.filter(
        e => e.type === 'permanent_skip_retry' && e.provider === 'fallback'
      );
      expect(permanentSkip.length).toBe(1);

      const fallbackRetryScheduled = emitted.filter(
        e => e.type === 'retry_scheduled' && e.provider === 'fallback'
      );
      expect(fallbackRetryScheduled.length).toBe(0);
    });
  });
});

/**
 * phase 686 Step A: streaming 路径补 fallback_switched emit
 *
 * 反向测试 ≥3 项：
 * - primary 失败 + fallback 成功 → emit fallback_switched { from: primary, to: fallback }
 * - 链式 2 fallback：第一失败、第二也失败、第三成功 → 2 个 fallback_switched
 * - primary 直接成功 → 0 fallback_switched
 */
describe('streaming-fallback-switched-emit', () => {
  function createMockSink() {
    const emitted: LLMEvent[] = [];
    const sink: LLMEventSink = {
      emit(event: LLMEvent) { emitted.push(event); }
    };
    return { sink, emitted };
  }

  function alwaysFailingStreamProvider(name: string): ProviderAdapter {
    return {
      name,
      model: `${name}-model`,
      async call() { throw new Error(`${name} call fail`); },
      async *stream() {
        throw new Error(`${name} stream fail`);
      },
    };
  }

  function successStreamProvider(name: string): ProviderAdapter {
    return {
      name,
      model: `${name}-model`,
      async call() { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } as any; },
      async *stream() {
        yield { type: 'text_delta', delta: 'hello' };
        yield { type: 'done' };
      },
    };
  }

  function buildOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
    const { sink, emitted } = createMockSink();
    const orchestrator = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'k', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'k', model: fb.model, apiFormat: 'anthropic' as const })),
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (orchestrator as any).primary = primary;
    (orchestrator as any).fallbacks = fallbacks;
    (orchestrator as any).breakers = [primary, ...fallbacks].map(() => new CircuitBreaker(5, 1000, () => {}));
    return { orchestrator, emitted };
  }

  async function consume(gen: AsyncIterableIterator<any>): Promise<any[]> {
    const chunks: any[] = [];
    for await (const c of gen) chunks.push(c);
    return chunks;
  }

  describe('phase 686 Step A: streaming fallback_switched emit', () => {
    it('primary 失败 + fallback 成功 → emit 1 fallback_switched (from primary, to fallback)', async () => {
      const primary = alwaysFailingStreamProvider('primary');
      const fallback = successStreamProvider('fallback');
      const { orchestrator, emitted } = buildOrchestrator(primary, [fallback]);

      await consume(orchestrator.stream({}));

      const switches = emitted.filter(e => e.type === 'fallback_switched');
      expect(switches).toHaveLength(1);
      expect(switches[0]).toMatchObject({
        type: 'fallback_switched',
        from: 'primary',
        to: 'fallback',
      });
    });

    it('链式失败：primary + fb1 失败、fb2 成功 → 1 fallback_switched (from=fb1, to=fb2)', async () => {
      // lazy announce 语义：fallback_switched 仅在「下个 provider 首 chunk 成功 yield」时 emit
      // primary 失败 0 chunk + fb1 失败 0 chunk → fb2 首 chunk 时只 announce (from=fb1, to=fb2)
      // 中间 fb1 的失败由 provider_failed 事件可见、不需独立 switch 行
      const primary = alwaysFailingStreamProvider('primary');
      const fb1 = alwaysFailingStreamProvider('fb1');
      const fb2 = successStreamProvider('fb2');
      const { orchestrator, emitted } = buildOrchestrator(primary, [fb1, fb2]);

      const chunks = await consume(orchestrator.stream({}));

      const switches = emitted.filter(e => e.type === 'fallback_switched');
      expect(switches).toHaveLength(1);
      expect(switches[0]).toMatchObject({ from: 'fb1', to: 'fb2' });

      // provider_failed yield 在 chunk 流中保留 primary + fb1 失败可见性
      const failedProviders = chunks.filter(c => c.type === 'provider_failed').map(c => c.provider).sort();
      expect(failedProviders).toEqual(['fb1', 'primary']);
    });

    it('primary 直接成功 → 0 fallback_switched', async () => {
      const primary = successStreamProvider('primary');
      const fallback = successStreamProvider('fallback');
      const { orchestrator, emitted } = buildOrchestrator(primary, [fallback]);

      await consume(orchestrator.stream({}));

      const switches = emitted.filter(e => e.type === 'fallback_switched');
      expect(switches).toHaveLength(0);
    });

    it('mid-stream fail then fallback succeeds → emit 1 fallback_switched', async () => {
      const midFailPrimary: ProviderAdapter = {
        name: 'primary',
        model: 'primary-model',
        async call() { return { content: [], stop_reason: 'end_turn' } as any; },
        async *stream() {
          yield { type: 'text_delta', delta: 'partial' };
          throw new Error('mid-stream failure');
        },
      };
      const fallback = successStreamProvider('fallback');
      const { orchestrator, emitted } = buildOrchestrator(midFailPrimary, [fallback]);

      await consume(orchestrator.stream({}));

      const switches = emitted.filter(e => e.type === 'fallback_switched');
      expect(switches).toHaveLength(1);
      expect(switches[0]).toMatchObject({ from: 'primary', to: 'fallback' });
    });
  });
});

describe('user-action-hint-coverage', () => {
  // phase 1425: 反向 coverage 守 getUserActionHint 对所有 LLMError 子类返回非 null
  // （除 base LLMError + 非 LLMError 错走显式 null 设计）

  describe('getUserActionHint coverage (phase 1425)', () => {
    it('LLMTimeoutError → check_endpoint', () => {
      expect(getUserActionHint(new LLMTimeoutError('anthropic', 60_000))).toBe('check_endpoint');
    });

    it('LLMNetworkError → check_network', () => {
      expect(getUserActionHint(new LLMNetworkError('openai', new Error('ECONNRESET')))).toBe('check_network');
    });

    it('LLMAuthError with quota keyword → check_quota', () => {
      expect(getUserActionHint(new LLMAuthError('anthropic', 401, 'insufficient credits'))).toBe('check_quota');
    });

    it('LLMAuthError default → rotate_api_key', () => {
      expect(getUserActionHint(new LLMAuthError('anthropic', 401))).toBe('rotate_api_key');
    });

    it('LLMModelNotFoundError → switch_primary', () => {
      expect(getUserActionHint(new LLMModelNotFoundError('anthropic', 'nonexistent-model'))).toBe('switch_primary');
    });

    it('LLMRateLimitError → wait_retry_after', () => {
      expect(getUserActionHint(new LLMRateLimitError('anthropic'))).toBe('wait_retry_after');
    });

    it('non-LLM Error → null (displays as "see audit log" in CLI)', () => {
      expect(getUserActionHint(new Error('unexpected'))).toBeNull();
    });
  });
});
