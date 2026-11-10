import { describe, expect, it, vi } from 'vitest';
import { LLMProviderRuntime } from '../../../src/foundation/llm-orchestrator/provider-runtime.js';
import type { LLMEvent, LLMEventSink, LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import type { LLMProvider, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

function config(
  primary: ProviderConfig,
  events: LLMEventSink,
  createProviderAdapter: (config: ProviderConfig) => LLMProvider,
  fallbacks: ProviderConfig[] = [],
): LLMOrchestratorConfig {
  return { primary, fallbacks, maxAttempts: 1, retryDelayMs: 0, events, createProviderAdapter };
}

function adapter(config: ProviderConfig, close?: () => void | Promise<void>): LLMProvider {
  return {
    name: config.name,
    model: config.model,
    call: async () => ({ content: [], stop_reason: 'end_turn' }),
    ...(close ? { close } : {}),
  };
}

function sink() {
  const events: LLMEvent[] = [];
  return { events, sink: { emit: (event: LLMEvent) => { events.push(event); } } satisfies LLMEventSink };
}

const primaryConfig: ProviderConfig = { name: 'primary', model: 'm1', apiKey: 'k1', apiFormat: 'anthropic' };
const nextConfig: ProviderConfig = { name: 'next', model: 'm2', apiKey: 'k2', apiFormat: 'openai' };

describe('ProviderRuntime cache and reload lifecycle', () => {
  it('owns cache identity and prepares adapters without activating them before commit', () => {
    const eventSink = sink();
    const created: LLMProvider[] = [];
    const factory = (providerConfig: ProviderConfig) => {
      const createdAdapter = adapter(providerConfig);
      created.push(createdAdapter);
      return createdAdapter;
    };
    const runtime = new LLMProviderRuntime(config(primaryConfig, eventSink.sink, factory, [{ ...primaryConfig }]));
    const original = runtime.primary();
    expect(runtime.fallbacks()[0]).toBe(original);
    expect(created).toHaveLength(1);

    const generation = runtime.configGeneration();
    const identities = runtime.providerIds();
    const prepared = runtime.prepareReload(config(nextConfig, eventSink.sink, factory));
    const next = prepared.primary;
    expect(runtime.primary()).toBe(original);
    expect(runtime.configGeneration()).toBe(generation);
    expect(runtime.providerIds()).toBe(identities);
    expect(runtime.config().primary.name).toBe('primary');
    expect(next).not.toBe(original);

    runtime.commitReload(prepared);
    expect(runtime.primary()).toBe(next);
    expect(runtime.configGeneration()).toBe(generation + 1);
    expect(runtime.providerIds()).toEqual(prepared.providerIds);
    expect(runtime.legacyProviderIds()).toEqual(prepared.legacyProviderIds);
    expect(runtime.config().primary.name).toBe('next');
    expect([...runtime.clientCache.values()]).toEqual([next]);

    const restored = runtime.prepareReload(config(primaryConfig, eventSink.sink, factory));
    expect(restored.primary).not.toBe(original);
    expect(eventSink.events.filter(event => event.type === 'sdk_client_cache_miss')).toHaveLength(3);
    expect(eventSink.events.filter(event => event.type === 'sdk_client_cache_hit')).toHaveLength(1);
  });

  it('closes active and delayed old providers once and clears the real cache', async () => {
    const eventSink = sink();
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const factory = (providerConfig: ProviderConfig) => {
      const close = vi.fn();
      closes.set(providerConfig.name, close);
      return adapter(providerConfig, close);
    };
    const runtime = new LLMProviderRuntime(config(primaryConfig, eventSink.sink, factory));
    const prepared = runtime.prepareReload(config(nextConfig, eventSink.sink, factory));
    runtime.commitReload(prepared);

    await runtime.close();
    await runtime.close();

    expect(closes.get('primary')).toHaveBeenCalledTimes(1);
    expect(closes.get('next')).toHaveBeenCalledTimes(1);
    expect(runtime.clientCache.size).toBe(0);
  });

  it('continues closing after a provider failure and emits the existing close event', async () => {
    const eventSink = sink();
    const goodClose = vi.fn();
    const runtime = new LLMProviderRuntime(config(primaryConfig, eventSink.sink, providerConfig =>
      providerConfig.name === 'primary'
        ? adapter(providerConfig, async () => { throw new Error('close failed'); })
        : adapter(providerConfig, goodClose)));
    runtime.clientCache.set('good', adapter({ name: 'good', model: 'm', apiFormat: 'openai' }, goodClose));

    await expect(runtime.close()).resolves.toBeUndefined();

    expect(goodClose).toHaveBeenCalledTimes(1);
    expect(runtime.clientCache.size).toBe(0);
    expect(eventSink.events).toContainEqual({ type: 'provider_close_failed', error: 'Error: close failed' });
  });
});
