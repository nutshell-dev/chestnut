/**
 * mergeSignals cleanup tests
 * Phase 538 Step B — D.5
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { ProviderAdapter, LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';

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
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
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
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
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
