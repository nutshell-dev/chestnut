import { legacyProviderFactory } from './provider-test-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { computeDynamicCallTimeoutMs, estimatePromptTokens } from '../../../src/foundation/llm-orchestrator/utils.js';
import { observeInputBudget, timeoutInputTokens } from '../../../src/foundation/llm-orchestrator/input-budget.js';
import { LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type { LLMCallOptions, LLMEvent, LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
const { LLMContextExceededError } = llmProviderCall;
type LLMProvider = llmProviderCall.LLMProvider;
type ProviderStreamChunk = llmProviderCall.ProviderStreamChunk;
import type { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
type ModelInputMeter = llmProviderModelMeasurement.ModelInputMeter;
import type { ProviderConnection } from './provider-test-fixtures.js';

/** Short base timeout; dynamic input budgeting must increase it without a real wait. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;
const TEST_FALLBACK_PROVIDER_TIMEOUT_MS = 2_000;

const response = { content: [{ type: 'text' as const, text: 'ok' }], stop_reason: 'end_turn' as const };
const descriptor = (model: string, contextWindow = 1_000_000) => ({
  revision: `rev-${model}`,
  provider: model,
  model,
  api: 'test',
  contextWindow,
  profile: 'test',
});

function meter(model: string, tokens: number, contextWindow?: number): ModelInputMeter {
  return {
    descriptor: descriptor(model, contextWindow),
    capability: { kind: 'complete_only' },
    measure: () => ({ kind: 'estimated', tokens, method: 'deepseek-v41-text', reason: 'test' }),
  };
}

function config(name: string): ProviderConnection {
  return { providerId: name, model: name, authentication: { kind: 'api_key' as const, value: 'k', identity: 'k' }, apiFormat: 'anthropic', defaults: { timeoutMs: TEST_PROVIDER_TIMEOUT_MS, temperature: 0 } };
}

describe('L2 timeout estimate ownership', () => {
  it('keeps legacy allowance separate from real meter unavailability', async () => {
    const options = { messages: [] };
    const legacyEstimate = vi.fn(() => 123);
    const legacy = await observeInputBudget({
      name: 'legacy', model: 'legacy', call: async () => response,
    }, options, legacyEstimate);
    expect(legacy.measurement).toEqual({
      kind: 'estimated', method: 'legacy-cl100k', reason: 'adapter_capability_missing', tokens: 123,
    });
    expect(timeoutInputTokens(legacy)).toBe(123);
    expect(legacyEstimate).toHaveBeenCalledTimes(1);

    const unavailable = await observeInputBudget({
      name: 'metered', model: 'metered', call: async () => response,
      prepareInputMeter: async () => ({
        ...meter('metered', 999),
        measure: () => ({ kind: 'unavailable' as const, reason: 'test_unavailable' }),
      }),
    }, options, legacyEstimate);
    expect(legacyEstimate).toHaveBeenCalledTimes(1);
    expect(unavailable.measurement).toEqual({ kind: 'unavailable', reason: 'test_unavailable' });
    expect(timeoutInputTokens(unavailable)).toBe(0);
    expect(computeDynamicCallTimeoutMs(TEST_PROVIDER_TIMEOUT_MS, timeoutInputTokens(unavailable)))
      .toBe(TEST_PROVIDER_TIMEOUT_MS);
  });

  it('keeps a meter failure explicitly unavailable instead of fabricating usage', async () => {
    const legacyEstimate = vi.fn(() => 123);
    const observation = await observeInputBudget({
      name: 'broken', model: 'broken', call: async () => response,
      prepareInputMeter: async () => { throw new Error('meter setup failed'); },
    }, { messages: [] }, legacyEstimate);

    expect(legacyEstimate).not.toHaveBeenCalled();
    expect(observation).toEqual({ measurement: { kind: 'unavailable', reason: 'meter setup failed' } });
    expect(timeoutInputTokens(observation)).toBe(0);
    expect(observation.measurement).not.toHaveProperty('tokens');
  });
});

describe('sequential candidate timeout estimate fallback', () => {
  const cases = [
    { kind: 'estimated', expectedMs: 22_000 },
    { kind: 'zero', expectedMs: 2_000 },
    { kind: 'unavailable', expectedMs: 2_000 },
    { kind: 'prepare-reject', expectedMs: 2_000 },
    { kind: 'measure-throw', expectedMs: 2_000 },
    { kind: 'missing', expectedMs: undefined },
  ] as const;

  describe.each(['call', 'stream'] as const)('%s', mode => {
    it.each(cases)('uses only the fallback candidate measurement: $kind', async row => {
      const options: LLMCallOptions = {
        messages: [{ role: 'user', content: 'hello' }],
        system: 'timeout input probe',
        maxTokens: 123,
        temperature: 0.2,
      };
      const before = structuredClone(options);
      const received: { provider: string; mode: 'call' | 'stream'; timeoutMs?: number }[] = [];
      const events: LLMEvent[] = [];
      const primaryPrepare = vi.fn(async () => meter('primary', 50_000));
      const fallbackMeasure = vi.fn((
        input: Parameters<ModelInputMeter['measure']>[0],
      ): ReturnType<ModelInputMeter['measure']> => {
        expect(input).toStrictEqual(before);
        if (row.kind === 'measure-throw') throw new Error('synthetic-measure-failed');
        if (row.kind === 'unavailable') return { kind: 'unavailable', reason: 'synthetic-unavailable' };
        return {
          kind: 'estimated',
          tokens: row.kind === 'zero' ? 0 : 10_000,
          method: 'legacy-cl100k',
          reason: 'synthetic-estimate',
        };
      });
      const fallbackPrepare = vi.fn(async (): Promise<ModelInputMeter> => {
        if (row.kind === 'prepare-reject') throw new Error('synthetic-prepare-failed');
        return { ...meter('fallback', 10_000), measure: fallbackMeasure };
      });
      const make = (name: string): LLMProvider => {
        const adapter: LLMProvider = {
          name,
          model: name,
          call: async request => {
            received.push({ provider: name, mode: 'call', timeoutMs: request.timeoutMs });
            if (name === 'primary') throw new LLMNetworkError(name, new Error('offline'));
            return response;
          },
          stream: async function* (request): AsyncIterableIterator<ProviderStreamChunk> {
            received.push({ provider: name, mode: 'stream', timeoutMs: request.timeoutMs });
            if (name === 'primary') throw new LLMNetworkError(name, new Error('offline'));
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'done', stopReason: 'end_turn' };
          },
        };
        if (name === 'primary') adapter.prepareInputMeter = primaryPrepare;
        else if (row.kind !== 'missing') adapter.prepareInputMeter = fallbackPrepare;
        return adapter;
      };
      const fallbackConfig = config('fallback');
      const owner = createLLMOrchestrator({
        lifecycle: { mode: 'ephemeral' },
        primary: config('primary'),
        fallbacks: [{
          ...fallbackConfig,
          defaults: { ...fallbackConfig.defaults, timeoutMs: TEST_FALLBACK_PROVIDER_TIMEOUT_MS },
        }],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: { emit: event => events.push(event) },
        providerFactory: legacyProviderFactory(connection => make(connection.providerId)),
      });

      try {
        if (mode === 'call') {
          await expect(owner.call(options)).resolves.toBe(response);
        } else {
          const chunks = [];
          for await (const chunk of owner.stream(options)) chunks.push(chunk);
          expect(chunks).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'ok' }));
          expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
        }

        const legacy = estimatePromptTokens(options);
        expect(legacy).toBeGreaterThan(0);
        const missingMs = computeDynamicCallTimeoutMs(2_000, legacy);
        expect([2_000, 22_000, 101_000]).not.toContain(missingMs);
        expect(received).toStrictEqual([
          { provider: 'primary', mode, timeoutMs: computeDynamicCallTimeoutMs(TEST_PROVIDER_TIMEOUT_MS, 50_000) },
          { provider: 'fallback', mode, timeoutMs: row.expectedMs ?? missingMs },
        ]);
        expect(primaryPrepare).toHaveBeenCalledTimes(1);
        expect(primaryPrepare).toHaveBeenCalledWith({ maxTokens: 123, temperature: 0.2 });
        if (row.kind === 'missing') {
          expect(fallbackPrepare).not.toHaveBeenCalled();
        } else {
          expect(fallbackPrepare).toHaveBeenCalledTimes(1);
          expect(fallbackPrepare).toHaveBeenCalledWith({ maxTokens: 123, temperature: 0.2 });
        }
        if (row.kind === 'missing' || row.kind === 'prepare-reject') {
          expect(fallbackMeasure).not.toHaveBeenCalled();
        } else {
          expect(fallbackMeasure).toHaveBeenCalledTimes(1);
          expect(fallbackMeasure).toHaveBeenCalledWith(before);
        }
        expect(events.some(event => event.type === 'hedge_started')).toBe(false);
        expect(options).toStrictEqual(before);
      } finally {
        await owner.close();
      }
    });
  });
});

describe('configured candidate call defaults', () => {
  it('delivers only the actual fallback candidate defaults to its meter and call', async () => {
    const received: Array<{ provider: string; options: LLMCallOptions }> = [];
    const fallbackPrepare = vi.fn(async () => meter('fallback', 0));
    const make = (host: string): LLMProvider => {
      const name = host.split('.')[0]!;
      return {
        name, model: name,
        prepareInputMeter: name === 'fallback' ? fallbackPrepare : async () => meter('primary', 0),
        call: async options => {
          received.push({ provider: name, options });
          if (name === 'primary') throw new LLMNetworkError(name, new Error('offline'));
          return response;
        },
      };
    };
    const candidate = (name: string, timeoutMs: number, temperature: number, maxTokens: number) => ({
      input: {
        baseUrl: `https://${name}.example.test`, model: name, protocol: 'anthropic' as const,
        authentication: { kind: 'api_key' as const, value: `${name}-key` },
      },
      callDefaults: { timeoutMs, temperature, maxTokens },
    });
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: candidate('primary', 1_000, 0.1, 111),
      fallbacks: [candidate('fallback', 2_000, 0, 222)],
      maxAttempts: 1, retryDelayMs: 0, events: { emit: () => {} },
      providerFactory: legacyProviderFactory(connection => make(connection.providerId)),
    });
    await expect(owner.call({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toBe(response);
    expect(fallbackPrepare).toHaveBeenCalledWith({
      callDefaults: { timeoutMs: 2_000, temperature: 0, maxTokens: 222 }, // time-fixture: configuration/payload round-trip input, not an independent wait budget
    });
    expect(received[1]?.options.temperature).toBeUndefined();
    expect(received[1]?.options.maxTokens).toBeUndefined();
    expect(received[1]?.options).toMatchObject({
      callDefaults: { timeoutMs: 2_000, temperature: 0, maxTokens: 222 }, // time-fixture: configuration/payload round-trip input, not an independent wait budget
      timeoutMs: 2_000, // time-fixture: configuration/payload round-trip input, not an independent wait budget
    });
    expect(received[0]?.options.callDefaults).toMatchObject({ timeoutMs: 1_000, temperature: 0.1, maxTokens: 111 }); // time-fixture: configuration/payload round-trip input, not an independent wait budget
    await owner.close();
  });
});

describe.each(['call', 'stream'] as const)('%s legacy estimate scan deferral', mode => {
  it.each([
    { capability: 'metered', expectedScans: 0 },
    { capability: 'missing', expectedScans: 1 },
  ] as const)('scans $capability candidates $expectedScans time(s)', async ({ capability, expectedScans }) => {
    let scans = 0;
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const originalIterator = messages[Symbol.iterator].bind(messages);
    messages[Symbol.iterator] = () => {
      scans++;
      return originalIterator();
    };
    const options: LLMCallOptions = { messages };
    const make = (name: string): LLMProvider => {
      const adapter: LLMProvider = {
        name,
        model: name,
        call: async () => {
          if (name === 'primary') throw new LLMNetworkError(name, new Error('offline'));
          return response;
        },
        stream: async function* (): AsyncIterableIterator<ProviderStreamChunk> {
          if (name === 'primary') throw new LLMNetworkError(name, new Error('offline'));
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'done', stopReason: 'end_turn' };
        },
      };
      if (capability === 'metered') adapter.prepareInputMeter = async () => meter(name, 10);
      return adapter;
    };
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: config('primary'),
      fallbacks: [config('fallback')],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      providerFactory: legacyProviderFactory(connection => make(connection.providerId)),
    });

    try {
      if (mode === 'call') {
        await expect(owner.call(options)).resolves.toBe(response);
      } else {
        for await (const _chunk of owner.stream(options)) { /* consume the stream */ }
      }
      // Both missing-meter candidates share one invocation-local cached estimate.
      expect(scans).toBe(expectedScans);
    } finally {
      await owner.close();
    }
  });
});

describe('provider-bound input budget', () => {
  it('uses the meter belonging to the candidate that actually receives the call', async () => {
    const received: { provider: string; timeoutMs: number }[] = [];
    const make = (name: string, tokens: number): LLMProvider => ({
      name,
      model: name,
      prepareInputMeter: async () => meter(name, tokens),
      call: async options => {
        received.push({ provider: name, timeoutMs: options.timeoutMs! });
        if (name === 'primary') throw new LLMNetworkError(name, new Error('offline'));
        return response;
      },
    });
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: config('primary'),
      fallbacks: [config('fallback')],
      maxAttempts: 1,
      retryDelayMs: 0, // 禁用重试等待；输入预算用例只调用一次候选。
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      providerFactory: legacyProviderFactory(provider => make(provider.providerId, provider.providerId === 'primary' ? 10 : 50_000)),
    });

    await owner.call({ messages: [{ role: 'user', content: 'hello' }] });
    expect(received).toEqual([
      { provider: 'primary', timeoutMs: computeDynamicCallTimeoutMs(TEST_PROVIDER_TIMEOUT_MS, 10) },
      { provider: 'fallback', timeoutMs: computeDynamicCallTimeoutMs(TEST_PROVIDER_TIMEOUT_MS, 50_000) },
    ]);
    await owner.close();
  });

  it('keeps the primary trim anchor when failure evidence names a smaller fallback', async () => {
    const primaryDescriptor = descriptor('primary', 1_000_000);
    const fallbackDescriptor = descriptor('fallback', 256_000);
    const primaryPrepare = vi.fn(async () => ({ ...meter('primary', 1), descriptor: primaryDescriptor }));
    const fallbackPrepare = vi.fn(async () => ({ ...meter('fallback', 1, 256_000), descriptor: fallbackDescriptor }));
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: config('primary'),
      fallbacks: [config('fallback')],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      providerFactory: legacyProviderFactory(connection => ({
        name: connection.providerId,
        model: connection.model,
        prepareInputMeter: connection.providerId === 'primary' ? primaryPrepare : fallbackPrepare,
        call: async () => response,
      })),
    });
    const error = new LLMContextExceededError('fallback', 413, 'too large', {
      descriptor: fallbackDescriptor,
    });

    await expect(owner.prepareInputBudget({ kind: 'failure', error })).resolves.toMatchObject({
      kind: 'available', meter: { descriptor: primaryDescriptor },
    });
    expect(primaryPrepare).toHaveBeenCalledTimes(1);
    expect(fallbackPrepare).not.toHaveBeenCalled();
    await owner.close();
  });

  it('keeps the primary trim anchor after a fallback becomes the last successful provider', async () => {
    const primaryDescriptor = descriptor('primary', 1_000_000);
    const fallbackDescriptor = descriptor('fallback', 256_000);
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: config('primary'),
      fallbacks: [config('fallback')],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      providerFactory: legacyProviderFactory(connection => ({
        name: connection.providerId,
        model: connection.model,
        prepareInputMeter: async () => connection.providerId === 'primary'
          ? { ...meter('primary', 1), descriptor: primaryDescriptor }
          : { ...meter('fallback', 1, 256_000), descriptor: fallbackDescriptor },
        call: async () => {
          if (connection.providerId === 'primary') {
            throw new LLMContextExceededError('primary', 413, 'too large');
          }
          return response;
        },
      })),
    });

    await expect(owner.call({ messages: [] })).resolves.toBe(response);
    expect(owner.getProviderInfo()).toMatchObject({ name: 'fallback', isFallback: true });
    await expect(owner.prepareInputBudget({ kind: 'preview' })).resolves.toMatchObject({
      kind: 'available', meter: { descriptor: primaryDescriptor },
    });
    await owner.close();
  });

  it('uses the reloaded primary while preserving the old attempt descriptor', async () => {
    const oldDescriptor = descriptor('old-primary', 1_000_000);
    const newDescriptor = descriptor('new-primary', 2_000_000);
    const ownerConfig = {
      lifecycle: { mode: 'ephemeral' as const },
      primary: config('old-primary'),
      fallbacks: [],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      providerFactory: legacyProviderFactory(connection => ({
        name: connection.providerId,
        model: connection.model,
        prepareInputMeter: async () => connection.providerId === 'old-primary'
          ? { ...meter('old-primary', 1), descriptor: oldDescriptor }
          : { ...meter('new-primary', 1, 2_000_000), descriptor: newDescriptor },
        call: async () => response,
      })),
    };
    const owner = createLLMOrchestrator(ownerConfig);
    const oldBudget = await owner.prepareInputBudget({ kind: 'preview' });
    if (oldBudget.kind !== 'available') throw new Error('expected old primary meter');

    owner.reloadConfig({ ...ownerConfig, primary: config('new-primary') });
    const oldError = new LLMContextExceededError('old-primary', 413, 'too large', {
      descriptor: oldDescriptor,
    });
    await expect(owner.prepareInputBudget({ kind: 'failure', error: oldError })).resolves.toMatchObject({
      kind: 'available', meter: { descriptor: newDescriptor },
    });
    expect(oldBudget.meter.descriptor).toBe(oldDescriptor);
    expect(oldBudget.meter.descriptor.revision).toBe('rev-old-primary');
    await owner.close();
  });

  it('keeps a typed context failure target descriptor and its JSON evidence', () => {
    const error = new LLMContextExceededError('deepseek', 413, 'too large', {
      descriptor: descriptor('deepseek-flash[1m]'),
      inputTokens: 256_049,
      requestedMaxTokens: 8_192,
    });
    expect(error.toJSON()).toMatchObject({
      code: 'LLM_CONTEXT_EXCEEDED',
      context: { inputBudget: { descriptor: { revision: 'rev-deepseek-flash[1m]' }, inputTokens: 256_049 } },
    });
  });
});
