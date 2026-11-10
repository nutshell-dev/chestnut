import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMInstanceStateStore } from '../../../src/foundation/llm-orchestrator/instance-state-store.js';
import { LLMProbeController } from '../../../src/foundation/llm-orchestrator/probe-controller.js';
import { LLMProviderRuntime } from '../../../src/foundation/llm-orchestrator/provider-runtime.js';
import { LLMProviderAdmission } from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import { LLMRecoveryControllerImpl } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';
import type { LLMCallOptions, LLMEvent, LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import type { LLMProvider, LLMResponse, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

const OK: LLMResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const controllers: LLMProbeController[] = [];

function providerConfig(name: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { name, model: `model-${name}`, apiKey: `key-${name}`, apiFormat: 'anthropic', ...extra };
}

function fixture(primary: LLMProvider, fallbacks: LLMProvider[] = [], configExtra: Partial<ProviderConfig> = {}) {
  const events: LLMEvent[] = [];
  const config: LLMOrchestratorConfig = {
    primary: providerConfig(primary.name, configExtra),
    fallbacks: fallbacks.map(provider => providerConfig(provider.name)),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: event => { events.push(event); } },
    createProviderAdapter: provider => [primary, ...fallbacks].find(adapter => adapter.name === provider.name)!,
  };
  const runtime = new LLMProviderRuntime(config);
  const store = new LLMInstanceStateStore({
    mode: 'ephemeral',
    providerIds: runtime.providerIds(),
    legacyProviderIds: runtime.legacyProviderIds(),
    events: { emit: event => { events.push(event); } },
  });
  store.load();
  const ledger = new LLMRecoveryControllerImpl({
    store,
    providerIds: runtime.providerIds(),
    legacyProviderIds: runtime.legacyProviderIds(),
    admission: new LLMProviderAdmission(),
    emit: event => { events.push(event); },
  });
  const controller = new LLMProbeController({ runtime, ledger, events: { emit: event => { events.push(event); } } });
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
  it('pings one candidate with target limits and clears health without refreshing selection', async () => {
    let observed: LLMCallOptions | undefined;
    const primary: LLMProvider = {
      name: 'primary', model: 'model-primary',
      call: vi.fn(async options => { observed = options; return OK; }),
    };
    const fallback: LLMProvider = { name: 'fallback', model: 'model-fallback', call: vi.fn(async () => OK) };
    const f = fixture(primary, [fallback], { maxTokens: 32, timeoutMs: 1_000 });

    await expect(f.controller.probe()).resolves.toMatchObject({ ok: true, provider: 'primary' });

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
    expect(observed).toMatchObject({
      messages: [{ role: 'user', content: 'ping' }], maxTokens: 32, timeoutMs: 1_000,
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
    f.ledger.reloadProviderIdentities(prepared.providerIds, prepared.legacyProviderIds);
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
