/**
 * phase 686 Step B: getProviderInfo() 改返「正在流的 provider」
 *
 * 反向测试 ≥3 项：
 * - 流式中（首 chunk yield 后、stream 未完）getProviderInfo 返当前 adapter info（含正确 isFallback）
 * - 流式结束后 getProviderInfo 返 lastSuccessProvider（既有语义不破）
 * - failover 中（fallback 接管首 chunk 时）getProviderInfo 返 fallback adapter info + isFallback=true
 *   （这是修复目标：之前会返上一轮的 lastSuccessProvider）
 */

import { describe, it, expect } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import type {
  ProviderAdapter,
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

function buildOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const { sink } = createMockSink();
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
  return orchestrator;
}

describe('phase 686 Step B: getProviderInfo current-streaming-provider', () => {
  it('流式中首 chunk yield 后 getProviderInfo 返当前 adapter（不是 null、不是上次成功）', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'primary-model',
      async call() { return { content: [], stop_reason: 'end_turn' } as any; },
      async *stream() {
        yield { type: 'text_delta', delta: 'first' };
        yield { type: 'text_delta', delta: 'second' };
        yield { type: 'done' };
      },
    };
    const orchestrator = buildOrchestrator(primary, []);

    // 起步前 getProviderInfo 应为 null
    expect(orchestrator.getProviderInfo()).toBeNull();

    const gen = orchestrator.stream({});
    const first = await gen.next();
    expect(first.done).toBe(false);

    // 首 chunk yield 后 / stream 未完 → currentStreamingProvider 应已设
    const infoDuringStream = orchestrator.getProviderInfo();
    expect(infoDuringStream).toEqual({ name: 'primary', model: 'primary-model', isFallback: false });

    // drain
    while (!(await gen.next()).done) {}
  });

  it('流式结束后 getProviderInfo 返 lastSuccessProvider（既有语义保兼容）', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'primary-model',
      async call() { return { content: [], stop_reason: 'end_turn' } as any; },
      async *stream() {
        yield { type: 'text_delta', delta: 'x' };
        yield { type: 'done' };
      },
    };
    const orchestrator = buildOrchestrator(primary, []);

    const gen = orchestrator.stream({});
    for await (const _ of gen) { /* drain */ }

    // 流式结束后 currentStreamingProvider 已 finally 清回 null
    // getProviderInfo 回落到 lastSuccessProvider（updateLastSuccess 已设）
    const info = orchestrator.getProviderInfo();
    expect(info).toEqual({ name: 'primary', model: 'primary-model', isFallback: false });
  });

  it('failover 接管时 getProviderInfo 返 fallback info + isFallback=true（修复目标）', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'primary-model',
      async call() { throw new Error('primary fail'); },
      async *stream() { throw new Error('primary stream fail'); },
    };
    const fallback: ProviderAdapter = {
      name: 'fallback',
      model: 'fallback-model',
      async call() { return { content: [], stop_reason: 'end_turn' } as any; },
      async *stream() {
        yield { type: 'text_delta', delta: 'fb-first' };
        yield { type: 'done' };
      },
    };
    const orchestrator = buildOrchestrator(primary, [fallback]);

    const gen = orchestrator.stream({});
    // 迭代直到首个非-provider_failed chunk（fb 首 chunk）yield
    let firstContentChunk: any = null;
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      if (value.type !== 'provider_failed' && value.type !== 'reset') {
        firstContentChunk = value;
        break;
      }
    }
    expect(firstContentChunk).toMatchObject({ type: 'text_delta', delta: 'fb-first' });

    // 此刻 currentStreamingProvider 应反映 fallback adapter（不是 primary、不是 null）
    const infoDuringFallback = orchestrator.getProviderInfo();
    expect(infoDuringFallback).toEqual({ name: 'fallback', model: 'fallback-model', isFallback: true });

    // drain
    while (!(await gen.next()).done) {}
  });

  it('全失败时 finally 清 currentStreamingProvider → getProviderInfo 回 lastSuccess（既有语义）', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'primary-model',
      async call() { throw new Error('p fail'); },
      async *stream() { throw new Error('p stream fail'); },
    };
    const fallback: ProviderAdapter = {
      name: 'fallback',
      model: 'fallback-model',
      async call() { throw new Error('fb fail'); },
      async *stream() { throw new Error('fb stream fail'); },
    };
    const orchestrator = buildOrchestrator(primary, [fallback]);

    // before: no success → lastSuccess null
    expect(orchestrator.getProviderInfo()).toBeNull();

    await expect(async () => {
      for await (const _ of orchestrator.stream({})) { /* drain */ }
    }).rejects.toThrow();

    // 全失败后 currentStreamingProvider null + lastSuccessProvider 仍 null
    expect(orchestrator.getProviderInfo()).toBeNull();
  });
});
