import { describe, expect, it } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type { LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';
import type { LLMProvider, ModelInputMeter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/index.js';

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
    measure: () => ({ kind: 'counted', tokens, method: 'deepseek-v41-template' }),
  };
}

function config(name: string): ProviderConfig {
  return { name, model: name, apiKey: 'k', apiFormat: 'anthropic', timeoutMs: 1_000, temperature: 0 };
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
      retryDelayMs: 0,
      events: { emit: (() => {}) as LLMEventSink['emit'] },
      createProviderAdapter: provider => make(provider.name, provider.name === 'primary' ? 10 : 50_000),
    });

    await owner.call({ messages: [{ role: 'user', content: 'hello' }] });
    expect(received[0]).toBeGreaterThan(1_000);
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
