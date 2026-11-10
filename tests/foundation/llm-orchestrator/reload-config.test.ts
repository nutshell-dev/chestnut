/**
 * phase 320 Step A: LLMOrchestratorImpl.reloadConfig — 原地替换 primary/fallbacks/providerStates，对象引用不变。
 */

import { describe, it, expect } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { resolveLLMConfig } from '../../../src/core/llm-configuration/index.js';
import { createGlobalConfigSchema } from '../../../src/assembly/config/compose-config.js';
import type {
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';
import { internalsOf, providerStatesOf, replaceProviderStates, lastSuccessProviderOf } from './test-internals.js';

function createSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit(e: LLMEvent) { emitted.push(e); } };
  return { sink, emitted };
}

describe('phase 320 Step A: reloadConfig', () => {
  it('reload 后 primary 指向新 provider config', async () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const beforePrimary = internalsOf(orch).providerRuntime.primary();
    expect(beforePrimary.name).toBe('p1');

    orch.reloadConfig({
      primary: { name: 'p2', apiKey: 'k2', model: 'm2', apiFormat: 'openai' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const afterPrimary = internalsOf(orch).providerRuntime.primary();
    expect(afterPrimary.name).toBe('p2');
    expect(afterPrimary).not.toBe(beforePrimary);
  });

  it('reload 不换 orchestrator 对象引用（持有引用的调用方自动看到新 provider）', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const ref: { llm: LLMOrchestratorImpl } = { llm: orch };

    ref.llm.reloadConfig({
      primary: { name: 'p2', apiKey: 'k2', model: 'm2', apiFormat: 'openai' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    expect(ref.llm).toBe(orch);
    expect(internalsOf(ref.llm).providerRuntime.primary().name).toBe('p2');
  });

  it('fallbacks 数量变更：1 → 0', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      fallbacks: [
        { name: 'fb1', apiKey: 'kfb', model: 'mfb', apiFormat: 'openai' },
      ],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    expect(internalsOf(orch).providerRuntime.fallbacks().length).toBe(1);

    orch.reloadConfig({
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    expect(internalsOf(orch).providerRuntime.fallbacks().length).toBe(0);
  });

  it('provider 身份视图重建：reload 后 providerIds 数 = 1 + fallbacks 数，且不重建 breaker', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000 },
    });

    expect(internalsOf(orch).providerRuntime.providerIds()).toHaveLength(1);
    expect((orch as any).breakers).toBeUndefined();

    orch.reloadConfig({
      primary: { name: 'p2', apiKey: 'k2', model: 'm2', apiFormat: 'openai' },
      fallbacks: [
        { name: 'fb1', apiKey: 'kfb1', model: 'mfb1', apiFormat: 'anthropic' },
        { name: 'fb2', apiKey: 'kfb2', model: 'mfb2', apiFormat: 'openai' },
      ],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000 },
    });

    expect(internalsOf(orch).providerRuntime.providerIds()).toHaveLength(3);
    expect((orch as any).breakers).toBeUndefined();
  });

  it('events sink 引用保持（reload 不换 events）', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: { name: 'p1', apiKey: 'k1', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const eventsBefore = (orch as any).events;
    orch.reloadConfig({
      primary: { name: 'p2', apiKey: 'k2', model: 'm2', apiFormat: 'openai' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    const eventsAfter = (orch as any).events;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('reloadConfig 缺省不物化旧 circuit breaker 配置', () => {
    const { sink } = createSink();
    const cfgA = createGlobalConfigSchema().parse({
      llm: {
        primary: { preset: 'anthropic', api_key: 'kA', model: 'mA' },
      },
    });
    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' }, ...resolveLLMConfig(cfgA), events: sink });
    expect(internalsOf(orch).providerRuntime.providerIds()).toHaveLength(1);
    expect(internalsOf(orch).providerRuntime.config().circuitBreaker).toBeUndefined();
    expect((orch as any).breakers).toBeUndefined();

    const cfgB = createGlobalConfigSchema().parse({
      llm: {
        primary: { preset: 'openai', api_key: 'kB', model: 'mB' },
        fallbacks: [
          { preset: 'anthropic', api_key: 'kA', model: 'mA' },
        ],
      },
    });
    orch.reloadConfig({ ...resolveLLMConfig(cfgB), events: sink });
    expect(internalsOf(orch).providerRuntime.providerIds()).toHaveLength(2);
    expect((orch as any).breakers).toBeUndefined();
  });

  it('Phase 899: reloadConfig 淘汰不在新 config 中的旧 provider', () => {
    const { sink, emitted } = createSink();
    const cfgA = { name: 'pA', apiKey: 'kA', model: 'mA', apiFormat: 'anthropic' as const };
    const cfgB = { name: 'pB', apiKey: 'kB', model: 'mB', apiFormat: 'openai' as const };

    const orch = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: cfgA,
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    const pA = internalsOf(orch).providerRuntime.primary();
    const cache: Map<string, unknown> = internalsOf(orch).providerRuntime.clientCache;

    orch.reloadConfig({
      primary: cfgB,
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    const pB = internalsOf(orch).providerRuntime.primary();
    expect(pB).not.toBe(pA);
    // 旧 provider 应从 cache 移除
    expect(Array.from(cache.values()).includes(pA)).toBe(false);

    // 切回旧 config 时，旧实例已被淘汰，应创建新实例（cache miss）
    orch.reloadConfig({
      primary: cfgA,
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    const pA2 = internalsOf(orch).providerRuntime.primary();
    expect(pA2).not.toBe(pA);

    const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
    expect(misses.length).toBeGreaterThanOrEqual(2);
  });
});


describe('Phase 2027 selective runtime reload', () => {
  const policy = { failureThreshold: 3, resetTimeoutMs: 1_000 };
  const primary = { name: 'primary', apiKey: 'kp', model: 'mp', apiFormat: 'anthropic' as const, temperature: 0, timeoutMs: 1_000 };
  const fallbackA = { name: 'fallback-a', apiKey: 'ka', model: 'ma', apiFormat: 'anthropic' as const, temperature: 0, timeoutMs: 1_000 };
  const fallbackB = { name: 'fallback-b', apiKey: 'kb', model: 'mb', apiFormat: 'anthropic' as const, temperature: 0, timeoutMs: 1_000 };
  const baseConfig = (sink: LLMEventSink) => ({
    lifecycle: { mode: 'ephemeral' as const },
    primary,
    fallbacks: [fallbackA, fallbackB],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    circuitBreaker: policy,
  });

  it('只改 fallback B 时保留 primary/A 的 waiting 与 lastError', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl(baseConfig(sink));
    const ids = [...internalsOf(orch).providerRuntime.providerIds()] as string[];
    const records = ids.map((providerId, i) => ({
      providerId,
      status: 'waiting',
      retryAt: i + 1,
      lastError: { class: 'transient', at: i + 1, message: `offline-${i}` },
    }));
    replaceProviderStates(orch, records);

    orch.reloadConfig({
      ...baseConfig(sink),
      fallbacks: [fallbackA, { ...fallbackB, model: 'mb-new' }],
    });

    expect(providerStatesOf(orch)).toHaveLength(2);
    expect(providerStatesOf(orch)[0]).toEqual(records[0]);
    expect(providerStatesOf(orch)[1]).toEqual(records[1]);
    expect(providerStatesOf(orch).some((provider: { providerId: string }) =>
      provider.providerId === ids[2])).toBe(false);
    expect((orch as any).breakers).toBeUndefined();
  });

  it('只改 temperature 时保留故障身份与 waiting/lastError、清成功 cache，但创建新 adapter', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl(baseConfig(sink));
    const id = internalsOf(orch).providerRuntime.providerIds()[0];
    const adapter = internalsOf(orch).providerRuntime.primary();
    const record = {
      providerId: id,
      status: 'waiting',
      retryAt: 1,
      lastError: { class: 'transient', at: 1, message: 'offline' },
      lastSuccessAt: 1,
      cacheValidUntil: 2,
    };
    replaceProviderStates(orch, [record]);

    orch.reloadConfig({ ...baseConfig(sink), primary: { ...primary, temperature: 1 } });

    expect(internalsOf(orch).providerRuntime.providerIds()[0]).toBe(id);
    expect(providerStatesOf(orch)[0]).toMatchObject({
      providerId: id,
      status: 'waiting',
      retryAt: 1,
      lastError: record.lastError,
    });
    expect(providerStatesOf(orch)[0]).not.toHaveProperty('lastSuccessAt');
    expect(providerStatesOf(orch)[0]).not.toHaveProperty('cacheValidUntil');
    expect(lastSuccessProviderOf(orch)).toBeNull();
    expect(internalsOf(orch).providerRuntime.primary()).not.toBe(adapter);
  });

  it('breaker 策略变化只更新配置，providerStates 仍按身份保留', () => {
    const { sink } = createSink();
    const orch = new LLMOrchestratorImpl(baseConfig(sink));
    const ids = [...internalsOf(orch).providerRuntime.providerIds()] as string[];
    const record = {
      providerId: ids[0],
      status: 'waiting',
      retryAt: 1,
      lastError: { class: 'transient', at: 1, message: 'offline' },
    };
    replaceProviderStates(orch, [record]);

    orch.reloadConfig({
      ...baseConfig(sink),
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 2_000 },
    });

    expect(internalsOf(orch).providerRuntime.config().circuitBreaker.failureThreshold).toBe(5);
    expect(internalsOf(orch).providerRuntime.config().circuitBreaker.resetTimeoutMs).toBe(2_000);
    expect(providerStatesOf(orch)[0]).toEqual(record);
    expect((orch as any).breakers).toBeUndefined();
  });

  it('reload 后旧流正常完成但不写回 last-success', async () => {
    const { sink } = createSink();
    let releaseDone!: () => void;
    const doneGate = new Promise<void>(resolve => { releaseDone = resolve; });
    const adapter = {
      name: 'primary',
      model: 'mp',
      async call() { return { content: [], stop_reason: 'end_turn' } as LLMResponse; },
      async *stream() {
        yield { type: 'text_delta' as const, delta: 'old-stream' };
        await doneGate;
        yield { type: 'done' as const };
      },
    };
    const config = {
      ...baseConfig(sink),
      fallbacks: [],
      createProviderAdapter: () => adapter,
    };
    const orch = new LLMOrchestratorImpl(config);
    const stream = orch.stream({});
    expect((await stream.next()).value).toMatchObject({ type: 'text_delta' });
    const pending = stream.next();
    const generation = internalsOf(orch).providerRuntime.configGeneration();

    orch.reloadConfig(config);
    expect(internalsOf(orch).providerRuntime.configGeneration()).toBe(generation + 1);
    releaseDone();
    expect((await pending).value).toMatchObject({ type: 'done' });
    expect((await stream.next()).done).toBe(true);
    expect(lastSuccessProviderOf(orch)).toBeNull();
  });
});
