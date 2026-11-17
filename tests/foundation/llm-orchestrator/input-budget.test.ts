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
const descriptor = (model: string) => ({
  revision: `rev-${model}`,
  provider: model,
  model,
  api: 'test',
  contextWindow: 1_000_000,
  profile: 'test',
});

function meter(model: string, tokens: number): ModelInputMeter {
  return {
    descriptor: descriptor(model),
    capability: { kind: 'complete_only' },
    measure: () => ({ kind: 'counted', tokens, method: 'deepseek-v41-template' }),
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

  it('matches canonical catalog evidence back to the labeled provider candidate', async () => {
    const aliasDescriptor = {
      ...descriptor('kimi-k2.6'),
      provider: 'moonshotai-cn',
      providerLabel: 'moonshot',
    };
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: { ...config('moonshot'), model: 'kimi-k2.6' },
      fallbacks: [],
      maxAttempts: 1,
      retryDelayMs: 0, // 禁用重试等待；输入预算用例只调用一次候选。
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      providerFactory: legacyProviderFactory((_connection) => ({
        name: 'moonshot',
        model: 'kimi-k2.6',
        prepareInputMeter: async () => ({ ...meter('kimi-k2.6', 1), descriptor: aliasDescriptor }),
        call: async () => response,
      })),
    });
    const error = new LLMContextExceededError('moonshot', 413, 'too large', {
      descriptor: aliasDescriptor,
    });

    await expect(owner.prepareInputBudget({ kind: 'failure', error })).resolves.toMatchObject({
      kind: 'available', meter: { descriptor: aliasDescriptor },
    });
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
