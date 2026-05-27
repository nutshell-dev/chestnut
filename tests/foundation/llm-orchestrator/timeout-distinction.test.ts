/**
 * LLMOrchestrator timeout distinction tests
 * Phase 538 Step B — D.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { ProviderAdapter, StreamChunk, LLMEventSink, LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';

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

vi.mock('../../../src/foundation/llm-provider/anthropic.js', () => ({
  AnthropicAdapter: class MockAnthropicAdapter {
    name = 'mock-anthropic';
    model = 'mock-model';
    constructor(public config: any) {}
    async call() {
      return {
        content: [{ type: 'text', text: 'mock response' }],
        stop_reason: 'end_turn',
      };
    }
    async *stream() {
      yield { type: 'text_delta', delta: 'mock chunk' };
      yield { type: 'done' };
    }
  },
}));

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
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
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
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000); // sleep: mock stream idle timeout
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
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
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
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: 'text_delta', delta: 'b' };
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: 'text_delta', delta: 'c' };
      yield { type: 'done' };
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
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
