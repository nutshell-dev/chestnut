/**
 * Stream idle probe tests (⚓4 ε ratified by phase 628)
 * Phase 637 Step A
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { LLMEventSink, LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';
import { createLLMProvider, type ProviderAdapter, type ProviderStreamChunk } from '../../../src/foundation/llm-provider/index.js';
import type { LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';

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
  streamImpl?: (opts: { signal?: AbortSignal }) => AsyncGenerator<ProviderStreamChunk>,
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

    const chunks: LLMStreamChunk[] = [];
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

    const chunks: LLMStreamChunk[] = [];
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

    const chunks: LLMStreamChunk[] = [];
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

    const chunks: LLMStreamChunk[] = [];
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
      const chunks: LLMStreamChunk[] = [];
      for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50, streamIdleProbeTimeoutMs: 50, signal: abortCtrl.signal })) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    await expect(promise).rejects.toThrow();
  });
});

/**
 * Phase 1941 (D1) 真实 adapter 边界组合：timeout owner 分层回归。
 *
 * 与本文件其余用例不同，这里 primary 是真实 PiAiAdapter（createLLMProvider +
 * 手搓可控滴流 SSE body，协议解析走 pi-ai 真实现），不是 mock adapter ——
 * 只有跨过真实 adapter/orchestrator 边界，才能证明“持续有 chunk 超过 provider
 * timeout_ms 仍不被 adapter 内部总时长 timer 误杀”（2026-10-16 缺陷登记形态）。
 */
describe('Phase 1941 真实 adapter 边界：stream timeout owner 分层', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 可控滴流 SSE Response：按 delays 逐帧 enqueue；signal abort 时以 AbortError 终止 body。 */
  function dripSseResponse(lines: string[], delays: number[], signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          controller.error(new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const push = () => {
          if (i >= lines.length) {
            signal?.removeEventListener('abort', onAbort);
            controller.close();
            return;
          }
          const idx = i++;
          timer = setTimeout(() => {
            controller.enqueue(encoder.encode(`${lines[idx]}\n\n`));
            push();
          }, delays[idx] ?? 0);
        };
        push();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  function openaiSse(frames: unknown[]): string[] {
    return [...frames.map((f) => `data: ${JSON.stringify(f)}`), 'data: [DONE]'];
  }

  function dripFrames(): unknown[] {
    return [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'a' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
  }

  function realPrimaryAdapter(timeoutMs: number): ProviderAdapter {
    return createLLMProvider({
      name: 'primary',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.test.invalid/v1',
      model: 'test-model',
      temperature: 0.7,
      timeoutMs,
      apiFormat: 'openai',
    });
  }

  it('持续 chunk 总时长超过 provider timeoutMs、间隔 < idleMs → 成功，无 idle 事件（缺陷回归）', async () => {
    const { sink, emitted } = createMockSink();
    // 首帧 20ms（< provider timeoutMs=800 握手上限）；随后每 1000ms 一帧，
    // chunk 间隔 < streamIdleTimeoutMs=4000，但总时长 ~2s > timeoutMs=800。
    // 旧行为：adapter 内部 800ms 总时长 timer 在流中段误 abort → stream_reset/恢复循环。
    // （时序边距按全量并行负载加宽，防 CI 调度抖动）
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) =>
      dripSseResponse(openaiSse(dripFrames()), [20, 1000, 1000, 5], init.signal ?? undefined)));

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = realPrimaryAdapter(800);

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 4000 })) {
      chunks.push(chunk);
    }

    const deltas = chunks.filter((c) => c.type === 'text_delta').map((c: any) => c.delta);
    expect(deltas).toEqual(['a', 'b']);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    // 无 idle probe / failover / reset —— adapter 内部 timer 未介入流中段
    expect(emitted.some((e) => e.type === 'stream_idle_probe_attempted')).toBe(false);
    expect(emitted.some((e) => e.type === 'idle_failover_triggered')).toBe(false);
    expect(emitted.some((e) => e.type === 'stream_reset')).toBe(false);
  });

  it('首事件后 chunk 间隔超过 streamIdleTimeoutMs → orchestrator idle probe/failover 接管（非 adapter timer）', async () => {
    const { sink, emitted } = createMockSink();
    let fetchCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
      fetchCount++;
      if (fetchCount === 1) {
        // stream：首帧 20ms 即到，随后 600ms 空窗 > streamIdleTimeoutMs=150
        return dripSseResponse(openaiSse(dripFrames()), [20, 600, 10, 5], init.signal ?? undefined);
      }
      // probe（adapter.call）：body 迟迟不出，probe 200ms 超时 → network_timeout
      return dripSseResponse(openaiSse(dripFrames()), [10_000, 10, 10, 5], init.signal ?? undefined);
    }));

    const fallback = createMockProvider('fallback');
    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    // provider timeoutMs 远大于 idleMs：若触发 idle 路径，必为 orchestrator idle watchdog 所为
    (service as any).primary = realPrimaryAdapter(5_000);
    (service as any).fallbacks = [fallback];

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 150, streamIdleProbeTimeoutMs: 200 })) {
      chunks.push(chunk);
    }

    // orchestrator idle 路径可观测：probe attempted + probe 超时失败 → idle failover
    expect(emitted.some((e) => e.type === 'stream_idle_probe_attempted')).toBe(true);
    expect(emitted.some((e) => e.type === 'idle_failover_triggered' && (e as any).ms === 150)).toBe(true);
    // fallback 接管并完成
    const deltas = chunks.filter((c) => c.type === 'text_delta').map((c: any) => c.delta);
    expect(deltas).toContain('Chunk from fallback');
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });
});
