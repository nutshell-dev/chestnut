/**
 * Phase 2045 Step C：非 hedge 每 attempt finally 清理验收。
 *
 * 锁语义：
 * - consumer 在真实内容 chunk yield 后提前 return：模块自建 idleTimer（fake timer 计数 0）
 *   与 merged signal 注册的外部 abort callback（removeEventListener 且引用一致）必须清理；
 *   不以 provider iterator 的 return 替代模块自身资源清理。
 * - provider iterator.return 被调用（流源关闭）+ currentStreamingProvider 回落既有语义。
 * - 正常 drain / 握手异常路径同样清理收敛（不依赖退出方式，scoped interrupted 结算不变）；
 *   实例级持续 probe 不属于单 stream 资源，统一在 owner.close() 后断言 timer=0。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { LLMEventSink, LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';
import type { ProviderAdapter, ProviderStreamChunk } from '../../../src/foundation/llm-provider/index.js';

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

/** 构造 provider stream 实现并追踪其 iterator.return 被调用（generator 提前退出时 for-await 必经）。 */
function trackedStream(
  chunks: ProviderStreamChunk[],
  onReturn: () => void,
): (opts: { signal?: AbortSignal }) => AsyncGenerator<ProviderStreamChunk> {
  return () => {
    const gen = (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
    const originalReturn = gen.return.bind(gen);
    gen.return = ((value?: unknown) => {
      onReturn();
      return originalReturn(value as never);
    }) as typeof gen.return;
    return gen;
  };
}

function buildOrchestrator(primary: ProviderAdapter) {
  const { sink } = createMockSink();
  const orchestrator = new LLMOrchestratorImpl({
    lifecycle: { mode: 'ephemeral' },
    primary: { name: primary.name, apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const },
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    createProviderAdapter: () => primary,
  });
  return orchestrator;
}

/** 捕获外部 AbortSignal 上 add/remove 的 abort listener 引用（验证注册过的 callback 被移除）。 */
function spySignalListeners(signal: AbortSignal) {
  const added: Array<{ type: string; listener: unknown }> = [];
  const removed: Array<{ type: string; listener: unknown }> = [];
  vi.spyOn(signal, 'addEventListener').mockImplementation((type: any, listener: any, options?: any) => {
    added.push({ type, listener });
    EventTarget.prototype.addEventListener.call(signal, type, listener, options);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type: any, listener: any, options?: any) => {
    removed.push({ type, listener });
    EventTarget.prototype.removeEventListener.call(signal, type, listener, options);
  });
  return { added, removed };
}

/** 断言：外部 signal 上注册过的每个 abort callback 都被以同一引用 remove。 */
function expectAbortListenersRemoved(
  captured: ReturnType<typeof spySignalListeners>,
) {
  const addedAbort = captured.added.filter((c) => c.type === 'abort').map((c) => c.listener);
  expect(addedAbort.length).toBeGreaterThan(0);
  for (const listener of addedAbort) {
    expect(
      captured.removed.some((c) => c.type === 'abort' && c.listener === listener),
    ).toBe(true);
  }
}

describe('Phase 2045 Step C: stream early-return resource cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('consumer 在内容 yield 后提前 return：timer/signal listener/provider iterator/current provider 全部清理', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const captured = spySignalListeners(ctrl.signal);

    let providerReturnCalls = 0;
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'mock-model',
      async call() { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } as any; },
      stream: trackedStream([
        { type: 'text_delta', delta: 'first' },
        { type: 'done' },
      ], () => { providerReturnCalls++; }),
    };
    const orchestrator = buildOrchestrator(primary);

    const iterator = orchestrator.stream({
      messages: [],
      signal: ctrl.signal,
      streamIdleTimeoutMs: 60_000,
    });

    // 真实首个内容 chunk 已 yield（idle timer 已 armed、外部 signal listener 已注册）
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: 'text_delta', delta: 'first' });
    expect(captured.added.filter((c) => c.type === 'abort').length).toBeGreaterThan(0);

    // consumer 提前 return
    const ret = await iterator.return();
    expect(ret.done).toBe(true);

    // provider 流源被关闭
    expect(providerReturnCalls).toBe(1);
    // 模块自建 idle timer 与实例自主 probe 调度均在 owner 关闭后归零。
    await orchestrator.close();
    expect(vi.getTimerCount()).toBe(0);
    // 外部 signal 上注册过的 abort callback 被移除（add/remove 引用一致）
    expectAbortListenersRemoved(captured);
    // currentStreamingProvider 已清 → getProviderInfo 回落 primary（既有语义）
    expect(orchestrator.getProviderInfo()).toEqual({ name: 'primary', model: 'mock-model', isFallback: false });
  });

  it('正常 drain 成功路径：finally 清理后 timer=0、abort listener 移除', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const captured = spySignalListeners(ctrl.signal);

    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'mock-model',
      async call() { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } as any; },
      stream: trackedStream([
        { type: 'text_delta', delta: 'first' },
        { type: 'done' },
      ], () => {}),
    };
    const orchestrator = buildOrchestrator(primary);

    for await (const _ of orchestrator.stream({
      messages: [],
      signal: ctrl.signal,
      streamIdleTimeoutMs: 60_000,
    })) { /* drain */ }

    await orchestrator.close();
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersRemoved(captured);
    expect(orchestrator.getProviderInfo()).toEqual({ name: 'primary', model: 'mock-model', isFallback: false });
  });

  it('provider 握手异常路径：finally 清理后 timer=0、abort listener 移除', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const captured = spySignalListeners(ctrl.signal);

    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'mock-model',
      async call() { throw new Error('call fail'); },
      async *stream() { throw new Error('handshake fail'); },
    };
    const orchestrator = buildOrchestrator(primary);

    await expect(async () => {
      for await (const _ of orchestrator.stream({
        messages: [],
        signal: ctrl.signal,
        streamIdleTimeoutMs: 60_000,
      })) { /* drain */ }
    }).rejects.toThrow();

    await orchestrator.close();
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersRemoved(captured);
  });
});
