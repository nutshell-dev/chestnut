import { legacyProviderFactory } from './provider-test-fixtures.js';
import { describe, expect, it } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';
import { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
const { LLMContextExceededError } = llmProviderCall;
type LLMProvider = llmProviderCall.LLMProvider;
import type { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
type ModelInputMeter = llmProviderModelMeasurement.ModelInputMeter;
import type { ProviderConnection } from './provider-test-fixtures.js';

/** Short base timeout; dynamic input budgeting must increase it without a real wait. */
const TEST_PROVIDER_TIMEOUT_MS = 1_000;

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

describe('provider-bound input budget', () => {
  it('uses the meter belonging to the candidate that actually receives the call', async () => {
    const received: number[] = [];
    const make = (name: string, tokens: number): LLMProvider => ({
      name,
      model: name,
      prepareInputMeter: async () => meter(name, tokens),
      call: async options => {
        received.push(options.timeoutMs!);
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
    expect(received[0]).toBeGreaterThan(TEST_PROVIDER_TIMEOUT_MS);
    await owner.close();
  });

  it('keeps the primary trim anchor when failure evidence names a smaller fallback', async () => {
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
        call: async () => response,
      })),
    });
    const error = new LLMContextExceededError('fallback', 413, 'too large', {
      descriptor: fallbackDescriptor,
    });

    await expect(owner.prepareInputBudget({ kind: 'failure', error })).resolves.toMatchObject({
      kind: 'available', meter: { descriptor: primaryDescriptor },
    });
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
