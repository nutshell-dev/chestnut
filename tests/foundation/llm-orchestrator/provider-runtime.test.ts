import { durableProviderCandidate, handleForProvider, legacyProviderFactory, providerEntryId } from './provider-test-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { LLMProviderRuntime } from '../../../src/foundation/llm-orchestrator/provider-runtime.js';
import type { LLMEvent, LLMEventSink, LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/types.js';
import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
type LLMProvider = llmProviderCall.LLMProvider;
import type { ProviderConnection } from './provider-test-fixtures.js';

function config(
  primary: ProviderConnection,
  events: LLMEventSink,
  providerFactory: (connection: ProviderConnection) => LLMProvider,
  fallbacks: ProviderConnection[] = [],
): LLMOrchestratorConfig {
  return {
    primary,
    fallbacks,
    maxAttempts: 1,
    retryDelayMs: 0, // 禁用重试等待；本 fixture 只测 runtime 生命周期。
    events,
    providerFactory: legacyProviderFactory(providerFactory),
  };
}

function adapter(config: ProviderConnection, close?: () => void | Promise<void>): LLMProvider {
  return {
    name: config.providerId,
    model: config.model,
    call: async () => ({ content: [], stop_reason: 'end_turn' }),
    ...(close ? { close } : {}),
  };
}

function sink() {
  const events: LLMEvent[] = [];
  return { events, sink: { emit: (event: LLMEvent) => { events.push(event); } } satisfies LLMEventSink };
}

const primaryConfig: ProviderConnection = { providerId: 'primary', model: 'm1', authentication: { kind: 'api_key' as const, value: 'k1', identity: 'k1' }, apiFormat: 'anthropic' };
const nextConfig: ProviderConnection = { providerId: 'next', model: 'm2', authentication: { kind: 'api_key' as const, value: 'k2', identity: 'k2' }, apiFormat: 'openai' };

describe('ProviderRuntime cache and reload lifecycle', () => {
  it('rejects missing or duplicate durable entry IDs before creating handles', () => {
    const eventSink = sink();
    const factory = vi.fn((connection: ProviderConnection) => adapter(connection));
    const base = config(primaryConfig, eventSink.sink, factory);
    expect(() => new LLMProviderRuntime({
      ...base,
      lifecycle: { mode: 'durable', fs: {} as never },
    })).toThrow('Missing persisted LLM entry ID');
    expect(factory).not.toHaveBeenCalled();

    const duplicate = durableProviderCandidate(primaryConfig);
    expect(() => new LLMProviderRuntime({
      ...base,
      primary: duplicate,
      fallbacks: [durableProviderCandidate(primaryConfig)],
      lifecycle: { mode: 'durable', fs: {} as never },
    })).toThrow('Duplicate LLM entry ID');
    expect(factory).not.toHaveBeenCalled();

    const runtime = new LLMProviderRuntime({
      ...base, primary: duplicate, lifecycle: { mode: 'durable', fs: {} as never },
    });
    const created = factory.mock.calls.length;
    expect(() => runtime.prepareReload({ ...base, primary: primaryConfig })).toThrow('Missing persisted LLM entry ID');
    expect(() => runtime.prepareReload({
      ...base, primary: duplicate, fallbacks: [durableProviderCandidate(primaryConfig)],
    })).toThrow('Duplicate LLM entry ID');
    expect(factory).toHaveBeenCalledTimes(created);
  });

  it('keys equal durable inputs by entry while keeping SDK cache and candidate defaults positional', () => {
    const eventSink = sink();
    const received: unknown[] = [];
    const factory = (connection: ProviderConnection) => {
      received.push(connection);
      return adapter(connection);
    };
    const first = {
      ...durableProviderCandidate(primaryConfig, providerEntryId('entry-a')),
      callDefaults: { temperature: 0.1 }, displayName: 'first',
    };
    const second = {
      ...durableProviderCandidate(primaryConfig, providerEntryId('entry-b')),
      callDefaults: { temperature: 0.9 }, displayName: 'second',
    };
    const runtime = new LLMProviderRuntime({
      ...config(primaryConfig, eventSink.sink, factory),
      primary: first, fallbacks: [second], lifecycle: { mode: 'durable', fs: {} as never },
    });
    expect(runtime.providerIds()).toEqual([`entry:${providerEntryId('entry-a')}`, `entry:${providerEntryId('entry-b')}`]);
    expect(runtime.operationalIdentities()[0]).not.toBe(runtime.operationalIdentities()[1]);
    expect(runtime.primary()).toBe(runtime.fallbacks()[0]);
    expect(runtime.callDefaults(runtime.primary(), 0)).toEqual({ temperature: 0.1 });
    expect(runtime.callDefaults(runtime.fallbacks()[0], 1)).toEqual({ temperature: 0.9 });
    expect(runtime.displayName(runtime.primary(), 0)).toBe('first');
    expect(runtime.displayName(runtime.fallbacks()[0], 1)).toBe('second');
    expect(received.every(input => typeof input === 'object' && input !== null && !('entryId' in input))).toBe(true);
    expect(runtime.clientCache).toHaveProperty('size', 1);

    const prepared = runtime.prepareReload({
      ...config(primaryConfig, eventSink.sink, factory),
      primary: second, fallbacks: [first], lifecycle: { mode: 'durable', fs: {} as never },
    });
    runtime.commitReload(prepared);
    expect(runtime.callDefaults(runtime.primary(), 0)).toEqual({ temperature: 0.9 });
    expect(runtime.callDefaults(runtime.fallbacks()[0], 1)).toEqual({ temperature: 0.1 });
    expect(runtime.displayName(runtime.primary(), 0)).toBe('second');
  });

  it('derives operational versions from authentication and defaults, not entry identity', () => {
    const eventSink = sink();
    const base = durableProviderCandidate(primaryConfig);
    const runtime = new LLMProviderRuntime({
      ...config(primaryConfig, eventSink.sink, adapter),
      primary: base, lifecycle: { mode: 'durable', fs: {} as never },
    });
    const before = runtime.operationalIdentities()[0];
    const renamed = runtime.prepareReload({
      ...config(primaryConfig, eventSink.sink, adapter),
      primary: { ...base, displayName: 'renamed' }, lifecycle: { mode: 'durable', fs: {} as never },
    });
    expect(renamed.operationalIdentities[0]).toBe(before);
    const changedAuth = runtime.prepareReload({
      ...config(primaryConfig, eventSink.sink, adapter),
      primary: {
        ...base,
        input: { ...primaryConfig, authentication: { kind: 'api_key', value: 'new', identity: 'new' } },
      },
      lifecycle: { mode: 'durable', fs: {} as never },
    });
    expect(changedAuth.operationalIdentities[0]).not.toBe(before);
  });

  it('uses positions for un-IDed ephemeral candidates', () => {
    const eventSink = sink();
    const runtime = new LLMProviderRuntime(config(primaryConfig, eventSink.sink, adapter, [{ ...primaryConfig }]));
    expect(runtime.providerIds()).toEqual(['ephemeral:0', 'ephemeral:1']);
  });

  it('owns cache identity and prepares adapters without activating them before commit', () => {
    const eventSink = sink();
    const created: LLMProvider[] = [];
    const factory = (providerConfig: ProviderConnection) => {
      const createdAdapter = adapter(providerConfig);
      created.push(createdAdapter);
      return createdAdapter;
    };
    const runtime = new LLMProviderRuntime(config(primaryConfig, eventSink.sink, factory, [{ ...primaryConfig }]));
    const original = runtime.primary();
    expect(runtime.fallbacks()[0]).toBe(original);
    expect(created).toHaveLength(2);

    const generation = runtime.configGeneration();
    const identities = runtime.providerIds();
    const prepared = runtime.prepareReload(config(nextConfig, eventSink.sink, factory));
    const next = prepared.primary;
    expect(runtime.primary()).toBe(original);
    expect(runtime.configGeneration()).toBe(generation);
    expect(runtime.providerIds()).toBe(identities);
    expect(runtime.config().primary.providerId).toBe('primary');
    expect(next).not.toBe(original);

    runtime.commitReload(prepared);
    expect(runtime.primary()).toBe(next);
    expect(runtime.configGeneration()).toBe(generation + 1);
    expect(runtime.providerIds()).toEqual(prepared.providerIds);
    expect(runtime.legacyProviderIds()).toEqual(prepared.legacyProviderIds);
    expect(runtime.config().primary.providerId).toBe('next');
    expect([...runtime.clientCache.values()].map(handle => handle.provider)).toEqual([next]);

    const restored = runtime.prepareReload(config(primaryConfig, eventSink.sink, factory));
    expect(restored.primary).not.toBe(original);
    expect(eventSink.events.filter(event => event.type === 'sdk_client_cache_miss')).toHaveLength(3);
    expect(eventSink.events.filter(event => event.type === 'sdk_client_cache_hit')).toHaveLength(1);
  });

  it('retires an unadopted cache-hit handle and emits protocol rather than preset', async () => {
    const eventSink = sink();
    const closes: ReturnType<typeof vi.fn>[] = [];
    const runtime = new LLMProviderRuntime(config(primaryConfig, eventSink.sink, providerConfig => {
      const close = vi.fn();
      closes.push(close);
      return adapter(providerConfig, close);
    }, [{ ...primaryConfig }]));

    expect(closes).toHaveLength(2);
    expect(closes[0]).not.toHaveBeenCalled();
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(eventSink.events).toContainEqual({
      type: 'sdk_client_cache_hit', protocol: 'anthropic', model: 'm1',
    });
    await runtime.close();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });

  it('closes active and delayed old providers once and clears the real cache', async () => {
    const eventSink = sink();
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const factory = (providerConfig: ProviderConnection) => {
      const close = vi.fn();
      closes.set(providerConfig.providerId, close);
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
      providerConfig.providerId === 'primary'
        ? adapter(providerConfig, async () => { throw new Error('close failed'); })
        : adapter(providerConfig, goodClose)));
    const goodInput = { providerId: 'good', model: 'm', apiFormat: 'openai', authentication: { kind: 'api_key' as const, value: 'good', identity: 'good' } };
    runtime.clientCache.set('good', handleForProvider(goodInput, adapter(goodInput, goodClose)));

    await expect(runtime.close()).resolves.toBeUndefined();

    expect(goodClose).toHaveBeenCalledTimes(1);
    expect(runtime.clientCache.size).toBe(0);
    expect(eventSink.events).toContainEqual({ type: 'provider_close_failed', error: 'Error: close failed' });
  });
});
