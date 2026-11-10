import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { llmOrchestratorConfigSchema } from '../../../src/foundation/llm-orchestrator/config-schema.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMOrchestratorConfig,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import {
  llmConfigIdentity,
  resolveLLMConfig,
  snapshotLLMConfig,
  snapshotLLMConfigInput,
} from '../../../src/core/llm-configuration/index.js';
import { createGlobalConfigSchema } from '../../../src/assembly/config/compose-config.js';

const PRIMARY = { name: 'primary', apiKey: 'key', model: 'model', apiFormat: 'anthropic' as const };
const FALLBACK = { name: 'fallback', apiKey: 'key', model: 'model', apiFormat: 'anthropic' as const };
const owners: LLMOrchestratorImpl[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const owner of owners.splice(0)) await owner.close();
});

function adapter(config: ProviderConfig): ProviderAdapter {
  return {
    name: config.name ?? 'unknown',
    model: config.model ?? 'unknown',
    async call() { throw new Error('offline'); },
    async *stream() { throw new Error('offline'); },
  };
}

function makeConfig(
  sink: LLMEventSink,
  circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number },
): LLMOrchestratorConfig & { lifecycle: { mode: 'ephemeral' } } {
  return {
    lifecycle: { mode: 'ephemeral' },
    primary: PRIMARY,
    fallbacks: [FALLBACK],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    createProviderAdapter: adapter,
    ...(circuitBreaker ? { circuitBreaker } : {}),
  };
}

function makeOwner(config: ReturnType<typeof makeConfig>): LLMOrchestratorImpl {
  const owner = new LLMOrchestratorImpl(config);
  owners.push(owner);
  return owner;
}

describe('legacy circuitBreaker diagnostics', () => {
  it('omits diagnostics for absent config and diagnoses explicit empty objects with parsed defaults', () => {
    const emitted: LLMEvent[] = [];
    const sink = { emit: (event: LLMEvent) => { emitted.push(event); } };
    const primary = { preset: 'anthropic', api_key: 'key', model: 'model' };

    expect(llmOrchestratorConfigSchema.parse({ primary }).circuit_breaker).toBeUndefined();
    makeOwner(makeConfig(sink));
    expect(emitted.filter(event => event.type === 'legacy_config_ignored')).toEqual([]);

    const parsed = createGlobalConfigSchema().parse({ llm: { primary, circuit_breaker: {} } });
    const resolved = resolveLLMConfig(parsed);
    makeOwner({ ...resolved, events: sink, lifecycle: { mode: 'ephemeral' }, createProviderAdapter: adapter });
    expect(emitted.filter(event => event.type === 'legacy_config_ignored')).toEqual([{
      type: 'legacy_config_ignored', field: 'circuitBreaker', reason: 'provider_retry_at_policy',
      value: { failureThreshold: 3, resetTimeoutMs: 60_000 },
    }]);
  });

  it('does not change retryAt or selection when only legacy values differ', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-10T00:00:00.000Z'));
    const firstEvents: LLMEvent[] = [];
    const secondEvents: LLMEvent[] = [];
    const first = makeOwner(makeConfig(
      { emit: event => { firstEvents.push(event); } },
      { failureThreshold: 1, resetTimeoutMs: 1_000 },
    ));
    const second = makeOwner(makeConfig(
      { emit: event => { secondEvents.push(event); } },
      { failureThreshold: 20, resetTimeoutMs: 3_600_000 },
    ));

    await expect(first.call({ messages: [] })).rejects.toThrow();
    await expect(second.call({ messages: [] })).rejects.toThrow();

    expect(await first.inspectRecoverySchedule()).toEqual(await second.inspectRecoverySchedule());
    const selections = (events: LLMEvent[]) => events
      .filter((event): event is Extract<LLMEvent, { type: 'call_selection' }> => event.type === 'call_selection')
      .map(event => ({
        outcome: event.outcome,
        provider: event.provider,
        providerId: event.providerId,
        attemptIndex: event.attemptIndex,
      }));
    expect(selections(firstEvents)).toEqual(selections(secondEvents));
  });

  it('publishes reload diagnostics only after the new config is accepted', () => {
    const emitted: LLMEvent[] = [];
    const sink = { emit: (event: LLMEvent) => { emitted.push(event); } };
    const config = makeConfig(sink);
    config.createProviderAdapter = provider => {
      if (provider.name === 'bad') throw new Error('invalid adapter');
      return adapter(provider);
    };
    const owner = makeOwner(config);
    const diagnostic = { failureThreshold: 5, resetTimeoutMs: 120_000 };

    expect(() => owner.reloadConfig({
      ...config,
      primary: { ...PRIMARY, name: 'bad' },
      circuitBreaker: diagnostic,
    })).toThrow('invalid adapter');
    expect(emitted.filter(event => event.type === 'legacy_config_ignored')).toEqual([]);

    owner.reloadConfig({
      ...config,
      primary: { ...PRIMARY, name: 'accepted' },
      circuitBreaker: diagnostic,
    });
    expect(emitted.filter(event => event.type === 'legacy_config_ignored')).toEqual([{
      type: 'legacy_config_ignored', field: 'circuitBreaker', reason: 'provider_retry_at_policy',
      value: diagnostic,
    }]);
  });

  it('keeps snapshot identity stable and includes explicit legacy values', () => {
    const input = {
      llm: {
        primary: { preset: 'anthropic', api_key: 'key', model: 'model' },
        circuit_breaker: { failure_threshold: 4, reset_timeout_ms: 90_000 },
      },
    } as const;
    const fromInput = snapshotLLMConfigInput(input);
    const fromDiskShape = snapshotLLMConfig(createGlobalConfigSchema().parse(input));

    expect(fromInput.identity).toBe(fromDiskShape.identity);
    expect(fromInput.identity).toBe(llmConfigIdentity(fromInput.config));
    expect(fromInput.identity).not.toBe(snapshotLLMConfigInput({
      llm: {
        ...input.llm,
        circuit_breaker: { failure_threshold: 5, reset_timeout_ms: 90_000 },
      },
    }).identity);
    expect(snapshotLLMConfigInput({ llm: { primary: input.llm.primary } }).identity)
      .not.toBe(fromInput.identity);
  });
});
