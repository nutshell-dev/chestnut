/**
 * phase 517 B7 regression：LLMOrchestratorImpl.close() 应清 sdkClientCache、
 * 调 provider 上的 optional close；close 后操作性入口统一拒绝。
 * phase 532: 加测试覆盖之前 phase 517 没建。
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLMOrchestratorClosedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type {
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';
import { internalsOf } from './test-internals.js';

function createSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit(e: LLMEvent) { emitted.push(e); } };
  return { sink, emitted };
}

describe('LLMOrchestratorImpl.close', () => {
  it('清空 sdkClientCache', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    // 触发 cache 写入：模 cache.set
    const cache: Map<string, unknown> = internalsOf(orch).providerRuntime.clientCache;
    cache.set('test-key', { close: () => undefined });
    expect(cache.size).toBeGreaterThanOrEqual(1);

    await orch.close();
    expect(cache.size).toBe(0);
  });

  it('调 provider 的 optional close（若存在）', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    let closeCalled = false;
    const cache: Map<string, unknown> = internalsOf(orch).providerRuntime.clientCache;
    cache.set('test-key', { close: () => { closeCalled = true; } });

    await orch.close();
    expect(closeCalled).toBe(true);
  });

  it('无 close 方法的 provider 兼容（optional chain）', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const cache: Map<string, unknown> = internalsOf(orch).providerRuntime.clientCache;
    cache.set('test-key', { /* no close */ });

    await expect(orch.close()).resolves.not.toThrow();
    expect(cache.size).toBe(0);
  });

  it('幂等：多次 close 不报错', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    await orch.close();
    await orch.close();
    await orch.close();
  });

  it('close 后真实请求与配置动作拒绝，且不产生 admission 或 provider 调用', async () => {
    const { sink, emitted } = createSink();
    const adapter = {
      name: 'p1',
      model: 'm1',
      call: vi.fn(),
      stream: vi.fn(),
    };
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      createProviderAdapter: () => adapter,
    });
    const options = { messages: [{ role: 'user' as const, content: 'hi' }] };
    const nextConfig = {
      primary: { name: 'p2', apiKey: 'k2', model: 'm2', apiFormat: 'openai' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    };

    await orch.close();

    await expect(orch.call(options)).rejects.toBeInstanceOf(LLMOrchestratorClosedError);
    await expect(orch.stream(options).next()).rejects.toBeInstanceOf(LLMOrchestratorClosedError);
    await expect(orch.healthCheck()).rejects.toBeInstanceOf(LLMOrchestratorClosedError);
    expect(() => orch.probe()).toThrow(LLMOrchestratorClosedError);
    expect(() => orch.reloadConfig(nextConfig)).toThrow(LLMOrchestratorClosedError);
    expect(orch.getFailureDisposition(new Error('plain'))).toBe('unknown');
    expect(orch.isClosed()).toBe(true);
    expect(adapter.call).not.toHaveBeenCalled();
    expect(adapter.stream).not.toHaveBeenCalled();
    expect(emitted.some(event => event.type === 'call_invocation_started')).toBe(false);
    await expect(orch.close()).resolves.toBeUndefined();
  });

  it('Phase 900: 单个 provider close 抛错时 emit 事件且其余仍关闭、cache 被清空', async () => {
    const { sink, emitted } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const goodClose = vi.fn().mockResolvedValue(undefined);
    const cache: Map<string, unknown> = internalsOf(orch).providerRuntime.clientCache;
    cache.set('bad', { close: async () => { throw new Error('bad close'); } });
    cache.set('good', { close: goodClose });

    await expect(orch.close()).resolves.toBeUndefined();
    expect(goodClose).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    const closeFailedEvents = emitted.filter(e => e.type === 'provider_close_failed');
    expect(closeFailedEvents.length).toBe(1);
    expect(closeFailedEvents[0]).toMatchObject({ type: 'provider_close_failed', error: 'Error: bad close' });
  });
});
