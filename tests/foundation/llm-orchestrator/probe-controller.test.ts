import { legacyProviderFactory } from './provider-test-fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMInstanceStateStore } from '../../../src/foundation/llm-orchestrator/instance-state-store.js';
import { LLMProbeController } from '../../../src/foundation/llm-orchestrator/probe-controller.js';
import { LLMProviderRuntime } from '../../../src/foundation/llm-orchestrator/provider-runtime.js';
import { LLMProviderAdmission } from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import { LLM_PROVIDER_SELECTION_TTL_MS } from '../../../src/foundation/llm-orchestrator/defaults.js';
import { LLMRecoveryControllerImpl } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';
import type { LLMCallOptions, LLMEvent, LLMInstanceLifecycle, LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
type LLMProvider = llmProviderCall.LLMProvider;
type LLMResponse = llmProviderCall.LLMResponse;
import type { ProviderConnection } from './provider-test-fixtures.js';

const OK: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const PROBE_TIMEOUT_MS = 1_000;
const controllers: LLMProbeController[] = [];

function providerConfig(name: string, extra: Partial<ProviderConnection> = {}): ProviderConnection {
  return { providerId: name, model: `model-${name}`, authentication: { kind: 'api_key' as const, value: `key-${name}`, identity: `key-${name}` }, apiFormat: 'anthropic', ...extra };
}

function fixture(
  primary: LLMProvider,
  fallbacks: LLMProvider[] = [],
  configExtra: Partial<ProviderConnection> = {},
  mode: LLMInstanceLifecycle['mode'] = 'durable',
) {
  const events: LLMEvent[] = [];
  const config: LLMOrchestratorConfig = {
    primary: providerConfig(primary.name, configExtra),
    fallbacks: fallbacks.map(provider => providerConfig(provider.name)),
    maxAttempts: 1,
    retryDelayMs: 0, // 禁用重试等待；probe 调度由 fake timers 控制。
    events: { emit: event => { events.push(event); } },
    providerFactory: legacyProviderFactory(provider => [primary, ...fallbacks].find(adapter => adapter.name === provider.providerId)!),
  };
  const runtime = new LLMProviderRuntime(config);
  const store = new LLMInstanceStateStore({
    mode: 'ephemeral',
    providerIds: runtime.providerIds(),
    operationalIdentities: runtime.operationalIdentities(),
    connectionProviderIds: runtime.connectionProviderIds(),
    legacyProviderIds: runtime.legacyProviderIds(),
    events: { emit: event => { events.push(event); } },
  });
  store.load();
  const ledger = new LLMRecoveryControllerImpl({
    store,
    providerIds: runtime.providerIds(),
    operationalIdentities: runtime.operationalIdentities(),
    admission: new LLMProviderAdmission(),
    emit: event => { events.push(event); },
  });
  const controller = new LLMProbeController({ runtime, ledger, events: { emit: event => { events.push(event); } }, mode });
  controllers.push(controller);
  return { config, controller, events, ledger, runtime, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-11-10T00:00:00.000Z');
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  vi.useRealTimers();
});

describe('ProbeController request and success semantics', () => {
  it('does not create an initial or reload autonomous schedule for ephemeral lifecycle', async () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary, [], {}, 'ephemeral');

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LLM_PROVIDER_SELECTION_TTL_MS);
    expect(primary.call).not.toHaveBeenCalled();

    f.controller.reload();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LLM_PROVIDER_SELECTION_TTL_MS);
    expect(primary.call).not.toHaveBeenCalled();
  });

  it('consumes the ledger decision and only converts its timer representation', () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary);
    const resumeAtMs = Date.now() + 30_000;
    const currentSchedule = vi.spyOn(f.ledger, 'currentSchedule')
      .mockReturnValueOnce({ kind: 'ready', revision: 1 })
      .mockReturnValueOnce({ kind: 'at', revision: 2, resumeAt: new Date(resumeAtMs).toISOString() })
      .mockReturnValueOnce({ kind: 'on_change', revision: 3 });

    expect(f.controller.getSharedRecoveryDecision()).toEqual({ kind: 'ready' });
    expect(f.controller.getSharedRecoveryDecision()).toEqual({ kind: 'at', nextProbeAt: resumeAtMs });
    expect(f.controller.getSharedRecoveryDecision()).toEqual({ kind: 'on_change' });
    expect(currentSchedule).toHaveBeenCalledTimes(3);
  });

  it('keeps probing an unavailable candidate while the instance decision is ready', async () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const fallback: LLMProvider = { name: 'fallback', model: 'model-fallback', call: vi.fn(async () => OK) };
    const f = fixture(primary, [fallback]);
    f.ledger.noteFailure([{
      providerId: f.runtime.providerIds()[0]!, errorClass: 'transient', message: 'primary offline',
      occurredAtMs: Date.now() - 1_000_000,
    }]);

    expect(f.controller.getSharedRecoveryDecision()).toEqual({ kind: 'ready' });
    await expect(f.controller.probe()).resolves.toMatchObject({ ok: true, provider: 'primary' });

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
    expect(f.ledger.snapshot().providers[0]).toMatchObject({ status: 'available', consecutiveFailures: 0 });
    expect(f.controller.getSharedRecoveryDecision()).toEqual({ kind: 'ready' });
  });

  it('pings one candidate with target limits and clears health without refreshing selection', async () => {
    let observed: LLMCallOptions | undefined;
    const primary: LLMProvider = {
      name: 'primary', model: 'model-primary',
      call: vi.fn(async options => { observed = options; return OK; }),
    };
    const fallback: LLMProvider = { name: 'fallback', model: 'model-fallback', call: vi.fn(async () => OK) };
    const f = fixture(primary, [fallback], { defaults: { maxTokens: 32, timeoutMs: PROBE_TIMEOUT_MS } });

    await expect(f.controller.probe()).resolves.toMatchObject({ ok: true, provider: 'primary' });

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
    expect(observed).toMatchObject({
      messages: [{ role: 'user', content: 'ping' }], maxTokens: 32, timeoutMs: PROBE_TIMEOUT_MS,
    });
    expect(observed?.hardTimeoutMs).toBeUndefined();
    expect(f.ledger.snapshot().providers[0]).toMatchObject({ providerId: f.runtime.providerIds()[0], status: 'available' });
    expect(f.ledger.snapshot().providers[0]).not.toHaveProperty('lastSuccessAt');
    expect(f.ledger.snapshot().providers[0]).not.toHaveProperty('cacheValidUntil');
  });

  it('cancels a scheduled probe on close without emitting ready', async () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary);
    const ready = vi.fn();
    f.controller.subscribeReady(ready);
    f.controller.scheduleProbe(Date.now() + 1_000);

    await f.controller.close();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(primary.call).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
});

describe('ProbeController lifecycle-aware autonomous re-arm', () => {
  it('keeps ephemeral failure facts and events without creating an autonomous timer', () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary, [], {}, 'ephemeral');

    f.ledger.noteFailure([{
      providerId: f.runtime.providerIds()[0]!, errorClass: 'transient', message: 'offline',
      occurredAtMs: Date.now(), retryAfterSec: 30,
    }]);

    expect(vi.getTimerCount()).toBe(0);
    expect(f.ledger.snapshot().providers[0]).toMatchObject({
      status: 'waiting', lastError: { message: 'offline' },
    });
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'recovery_scheduled', errorClass: 'transient', failureCount: 1,
    }));
  });

  it('preserves durable failure backoff after a failure commit', async () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary);
    vi.clearAllTimers(); // 移除构造期初始安排，只观察 failure callback。

    f.ledger.noteFailure([{
      providerId: f.runtime.providerIds()[0]!, errorClass: 'transient', message: 'offline',
      occurredAtMs: Date.now(), retryAfterSec: 30,
    }]);

    const retryAt = f.ledger.snapshot().providers[0]?.retryAt;
    expect(retryAt).toBe(Date.now() + 30_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.ledger.snapshot().providers[0]).toMatchObject({ status: 'waiting' });

    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(primary.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // Flush the continuation's microtasks.
    expect(primary.call).toHaveBeenCalledTimes(1);
  });

  it('runs an explicit ephemeral schedule once on success without a ready continuation', async () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary, [], {}, 'ephemeral');
    const ready = vi.fn();
    f.controller.subscribeReady(ready);

    f.controller.scheduleProbe(Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LLM_PROVIDER_SELECTION_TTL_MS * 2);
    expect(primary.call).toHaveBeenCalledTimes(1);
  });

  it('runs an explicit ephemeral schedule once on failure without a retry continuation', async () => {
    const primary: LLMProvider = {
      name: 'primary', model: 'model-primary',
      call: vi.fn(async () => { throw new Error('offline'); }),
    };
    const f = fixture(primary, [], {}, 'ephemeral');

    f.controller.scheduleProbe(Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.ledger.snapshot().providers[0]).toMatchObject({
      status: 'waiting', lastError: { message: 'offline' },
    });
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'provider_exhausted', provider: 'primary', error: 'offline',
    }));
    await vi.advanceTimersByTimeAsync(LLM_PROVIDER_SELECTION_TTL_MS * 2);
    expect(primary.call).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm an ephemeral explicit schedule when the recovery floor moves at timer fire', async () => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary, [], {}, 'ephemeral');
    f.controller.scheduleProbe(Date.now());
    f.ledger.noteFailure([{
      providerId: f.runtime.providerIds()[0]!, errorClass: 'rate_limit', message: 'limited',
      occurredAtMs: Date.now(), retryAfterSec: 60,
    }]);

    await vi.advanceTimersByTimeAsync(0);

    expect(primary.call).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.ledger.snapshot().providers[0]).toMatchObject({ status: 'waiting' });
  });

  it.each([
    { mode: 'ephemeral' as const, expectedTimers: 0 },
    { mode: 'durable' as const, expectedTimers: 1 },
  ])('emits timer rejection facts and applies the $mode continuation policy', async ({ mode, expectedTimers }) => {
    const primary: LLMProvider = { name: 'primary', model: 'model-primary', call: vi.fn(async () => OK) };
    const f = fixture(primary, [], {}, mode);
    vi.clearAllTimers();
    const probe = vi.spyOn(f.controller, 'probe').mockRejectedValueOnce(new Error('timer probe failed'));

    f.controller.scheduleProbe(Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'instance_state_write_failed', context: 'probe_timer', reason: 'timer probe failed',
    }));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(primary.call).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(expectedTimers);

    await vi.advanceTimersByTimeAsync(LLM_PROVIDER_SELECTION_TTL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(primary.call).not.toHaveBeenCalled();

    if (mode === 'durable') {
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0); // Flush the rejected timer's continuation.
      expect(probe).toHaveBeenCalledTimes(2);
      expect(primary.call).toHaveBeenCalledTimes(1);
    } else {
      await vi.advanceTimersByTimeAsync(LLM_PROVIDER_SELECTION_TTL_MS);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(primary.call).not.toHaveBeenCalled();
    }
  });
});


describe('ProbeController close, reload and late results', () => {
  it('aborts inflight work, waits for its exit and closes idempotently without publishing success', async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const primary: LLMProvider = {
      name: 'primary', model: 'model-primary',
      call: vi.fn((options: LLMCallOptions) => new Promise<LLMResponse>(resolve => {
        signal = options.signal;
        release = () => resolve(OK);
      })),
    };
    const f = fixture(primary);
    const pending = f.controller.probe();
    await Promise.resolve();

    const closing = f.controller.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.controller.close()).toBe(closing);

    release();
    await closing;
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(f.ledger.snapshot().providers).toEqual([]);
  });

  it('invalidates an old-generation success across reload', async () => {
    let release!: () => void;
    const primary: LLMProvider = {
      name: 'primary', model: 'model-primary',
      call: vi.fn(() => new Promise<LLMResponse>(resolve => { release = () => resolve(OK); })),
    };
    const f = fixture(primary);
    const pending = f.controller.probe();
    await Promise.resolve();

    const nextConfig: LLMOrchestratorConfig = {
      ...f.config,
      primary: { ...f.config.primary, model: 'next-model' },
    };
    const prepared = f.runtime.prepareReload(nextConfig);
    f.ledger.reloadProviderIdentities(prepared.providerIds, prepared.operationalIdentities);
    f.runtime.commitReload(prepared);
    f.controller.reload();
    release();

    await expect(pending).resolves.toMatchObject({ ok: true, provider: 'primary' });
    expect(f.ledger.snapshot().providers).toEqual([]);
  });

  it('does not clear a newer failure when an earlier probe succeeds late', async () => {
    let release!: () => void;
    const primary: LLMProvider = {
      name: 'primary', model: 'model-primary',
      call: vi.fn(() => new Promise<LLMResponse>(resolve => { release = () => resolve(OK); })),
    };
    const f = fixture(primary);
    const pending = f.controller.probe();
    await Promise.resolve();
    f.ledger.noteFailure([{
      providerId: f.runtime.providerIds()[0]!, errorClass: 'transient', message: 'new failure',
      occurredAtMs: Date.now() + 1,
    }]);
    release();

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(f.ledger.snapshot().providers[0]).toMatchObject({
      status: 'waiting', lastError: { at: Date.now() + 1, message: 'new failure' },
    });
  });
});
