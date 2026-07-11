/**
 * Stream idle probe tests (⚓4 ε ratified by phase 628)
 * Phase 637 Step A
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { ProviderAdapter, StreamChunk, LLMEventSink, LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';

/**
 * Mock stream 延长延迟 / mock probe 延长延迟: 让 stream 进入 idle window 后触 abort.
 * Derivation: = streamIdleTimeoutMs=50ms / streamIdleProbeTimeoutMs=50ms（与 it 参数一致）.
 */
const MOCK_STREAM_HOLD_MS = 50;

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

function createMockProvider(
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
  };
}

describe('Stream idle probe (⚓4 ε ratified by phase 628)', () => {
  it('probe success → retry same provider stream', async () => {
    const { sink, emitted } = createMockSink();

    let streamCallCount = 0;
    const primary = createMockProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        streamCallCount++;
        if (streamCallCount === 1) {
          // first stream: idle timeout
          yield { type: 'text_delta', delta: 'first' };
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, MOCK_STREAM_HOLD_MS);
            opts.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('AbortError'));
            });
          });
          yield { type: 'done' };
        } else {
          // retry stream: success
          yield { type: 'text_delta', delta: 'retry-ok' };
          yield { type: 'done' };
        }
      },
      async () => ({ content: [{ type: 'text', text: 'probe-ok' }], stop_reason: 'end_turn' }),
    );

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      maxAttempts: 2,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50 })) {
      chunks.push(chunk);
    }

    // 应收到 retry 成功后的内容
    expect(chunks.some((c) => c.type === 'text_delta' && (c as any).delta === 'retry-ok')).toBe(true);

    // probe attempted + succeeded 事件应被 emit
    expect(emitted.some((e) => e.type === 'stream_idle_probe_attempted')).toBe(true);
    expect(emitted.some((e) => e.type === 'stream_idle_probe_succeeded')).toBe(true);

    // 不应 failover 到 fallback（没有 fallback）
    expect(emitted.some((e) => e.type === 'idle_failover_triggered')).toBe(false);
  });

  it('probe network/timeout → failover next provider', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        yield { type: 'text_delta', delta: 'first' };
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, MOCK_STREAM_HOLD_MS);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
        yield { type: 'done' };
      },
      async (opts?: { signal?: AbortSignal }) => {
        // 模拟 probe 被 abort（network/timeout 类错误）
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('probe timeout'));
          }, MOCK_STREAM_HOLD_MS);
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    );

    const fallback = createMockProvider('fallback');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50, streamIdleProbeTimeoutMs: 50 })) {
        chunks.push(chunk);
      }
    } catch {
      // all providers may fail
    }

    // probe attempted 事件应被 emit
    expect(emitted.some((e) => e.type === 'stream_idle_probe_attempted')).toBe(true);

    // idle_failover_triggered 应被 emit（probe network/timeout → failover）
    expect(emitted.some((e) => e.type === 'idle_failover_triggered')).toBe(true);

    // probe succeeded 不应被 emit
    expect(emitted.some((e) => e.type === 'stream_idle_probe_succeeded')).toBe(false);
  });

  it('probe auth/model 错 → throw user-facing', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        yield { type: 'text_delta', delta: 'first' };
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, MOCK_STREAM_HOLD_MS);
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
        yield { type: 'done' };
      },
      async () => {
        const err = new Error('Invalid API key');
        err.name = 'AuthenticationError';
        throw err;
      },
    );

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;

    await expect(async () => {
      for await (const _ of service.stream({ messages: [], streamIdleTimeoutMs: 50 })) {
        // drain
      }
    }).rejects.toThrow('Invalid API key');

    // probe attempted 事件应被 emit
    expect(emitted.some((e) => e.type === 'stream_idle_probe_attempted')).toBe(true);

    // probe succeeded 不应被 emit
    expect(emitted.some((e) => e.type === 'stream_idle_probe_succeeded')).toBe(false);

    // idle_failover_triggered 不应被 emit（auth/model 直接 throw）
    expect(emitted.some((e) => e.type === 'idle_failover_triggered')).toBe(false);
  });
});


describe('Stream idle probe reset + done-guard + signal propagation (phase 893)', () => {
  it('emits reset before retry when idle probe succeeds after partial output', async () => {
    const { sink, emitted } = createMockSink();

    let streamCallCount = 0;
    const primary = createMockProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        streamCallCount++;
        if (streamCallCount === 1) {
          yield { type: 'text_delta', delta: 'partial' };
          // hang until idle abort fires
          await new Promise<void>((_, reject) => {
            opts.signal?.addEventListener('abort', () => {
              reject(new Error('AbortError'));
            });
          });
          yield { type: 'done' };
        } else {
          yield { type: 'text_delta', delta: 'retry-ok' };
          yield { type: 'done' };
        }
      },
      async () => ({ content: [{ type: 'text', text: 'probe-ok' }], stop_reason: 'end_turn' }),
    );

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      maxAttempts: 2,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50, streamIdleProbeTimeoutMs: 50 })) {
      chunks.push(chunk);
    }

    // reset chunk emitted before retry
    expect(chunks.some((c) => c.type === 'reset')).toBe(true);

    // partial output is not duplicated; retry content present
    expect(chunks.filter((c) => c.type === 'text_delta').map((c: any) => c.delta)).toEqual(['partial', 'retry-ok']);

    // probe succeeded event emitted
    expect(emitted.some((e) => e.type === 'stream_idle_probe_succeeded')).toBe(true);

    // stream_reset event emitted with idle_timeout_probe_retry reason
    expect(emitted.some((e) => e.type === 'stream_reset' && (e as any).error === 'idle_timeout_probe_retry')).toBe(true);
  });

  it('failovers when stream ends without done chunk', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockProvider(
      'primary',
      async function* () {
        yield { type: 'text_delta', delta: 'partial' };
        // clean EOF, no done chunk
      },
    );

    const fallback = createMockProvider(
      'fallback',
      async function* () {
        yield { type: 'text_delta', delta: 'full' };
        yield { type: 'done' };
      },
    );

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50 })) {
      chunks.push(chunk);
    }

    // partial yielded first, then reset from primary tells caller to discard partial state
    const textDeltas = chunks.filter((c) => c.type === 'text_delta').map((c: any) => c.delta);
    expect(textDeltas).toEqual(['partial', 'full']);

    // reset from primary
    expect(chunks.some((c) => c.type === 'reset')).toBe(true);

    // done from fallback
    expect(chunks.some((c) => c.type === 'done')).toBe(true);

    // failover event emitted
    expect(emitted.some((e) => e.type === 'fallback_switched')).toBe(true);
  });

  it('stops probe immediately on user abort', async () => {
    const { sink } = createMockSink();
    const abortCtrl = new AbortController();

    const primary = createMockProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        yield { type: 'text_delta', delta: 'first' };
        // hang until idle abort fires
        await new Promise<void>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new Error('AbortError'));
          });
        });
        yield { type: 'done' };
      },
      async (opts?: { signal?: AbortSignal }) => {
        abortCtrl.abort();
        return new Promise((_, reject) => {
          if (opts?.signal?.aborted) {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    );

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      maxAttempts: 2,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = primary;

    const promise = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50, streamIdleProbeTimeoutMs: 50, signal: abortCtrl.signal })) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await expect(promise).rejects.toThrow();
  });
});
