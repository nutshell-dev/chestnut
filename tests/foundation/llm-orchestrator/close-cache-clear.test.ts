/**
 * phase 517 B7 regression：LLMOrchestratorImpl.close() 应清 sdkClientCache、
 * 调 provider 上的 optional close、close 后再 call 会 lazy 重建。
 * phase 532: 加测试覆盖之前 phase 517 没建。
 */

import { describe, it, expect } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type {
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit(e: LLMEvent) { emitted.push(e); } };
  return { sink, emitted };
}

describe('LLMOrchestratorImpl.close', () => {
  it('清空 sdkClientCache', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    // 触发 cache 写入：模 cache.set
    const cache: Map<string, unknown> = (orch as unknown as { sdkClientCache: Map<string, unknown> }).sdkClientCache;
    cache.set('test-key', { close: () => undefined });
    expect(cache.size).toBeGreaterThanOrEqual(1);

    await orch.close();
    expect(cache.size).toBe(0);
  });

  it('调 provider 的 optional close（若存在）', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    let closeCalled = false;
    const cache: Map<string, unknown> = (orch as unknown as { sdkClientCache: Map<string, unknown> }).sdkClientCache;
    cache.set('test-key', { close: () => { closeCalled = true; } });

    await orch.close();
    expect(closeCalled).toBe(true);
  });

  it('无 close 方法的 provider 兼容（optional chain）', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const cache: Map<string, unknown> = (orch as unknown as { sdkClientCache: Map<string, unknown> }).sdkClientCache;
    cache.set('test-key', { /* no close */ });

    await expect(orch.close()).resolves.not.toThrow();
    expect(cache.size).toBe(0);
  });

  it('幂等：多次 close 不报错', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    await orch.close();
    await orch.close();
    await orch.close();
  });
});
