import { describe, it, expect, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { ContextTrimExhaustedError } from '../../../src/core/context_manager/errors.js';
import type { LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';

function createMockProvider(name: string): ProviderAdapter {
  return {
    name,
    model: 'test-model',
    call: vi.fn(),
    stream: vi.fn(),
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };
}

function createProviderConfig(name: string, apiKey: string): ProviderConfig {
  return {
    name,
    apiKey,
    model: 'test-model',
    apiFormat: 'anthropic',
    maxTokens: 1000,
    temperature: 0.7,
    timeoutMs: 30000,
  };
}

describe('orchestrator failover on ContextTrimExhaustedError', () => {
  it('switches to fallback when primary throws ContextTrimExhaustedError', async () => {
    const events: Array<Record<string, unknown>> = [];
    const eventSink: LLMEventSink = {
      emit: (e: Record<string, unknown>) => { events.push(e); },
    };

    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');

    primary.call.mockRejectedValue(new ContextTrimExhaustedError('trim exhausted'));
    fallback.call.mockResolvedValue({
      content: [{ type: 'text', text: 'fallback response' }],
      stop_reason: 'end_turn',
      model: 'fallback-model',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const orchestrator = new LLMOrchestratorImpl({
      primary: createProviderConfig('primary', 'key-p'),
      fallbacks: [createProviderConfig('fallback', 'key-f')],
      events: eventSink,
      maxAttempts: 1,
      retryDelayMs: 0,
      createAnthropicAdapter: (config) => config.name === 'fallback' ? fallback : primary,
    });

    // Verify fallback provider is distinct from primary
    expect((orchestrator as unknown as { fallbacks: Array<{ name: string }> }).fallbacks[0].name).toBe('fallback');

    const result = await orchestrator.call({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
    });

    expect(result.content[0]).toEqual({ type: 'text', text: 'fallback response' });
    expect(primary.call).toHaveBeenCalledOnce();
    expect(fallback.call).toHaveBeenCalledOnce();
    expect(events.some(e => e.type === 'context_exceeded_failover')).toBe(true);
  });

  it('throws LLMAllProvidersFailedError when all providers exhausted', async () => {
    const eventSink: LLMEventSink = {
      emit: () => {},
    };

    const primary = createMockProvider('primary');

    primary.call.mockRejectedValue(new ContextTrimExhaustedError('trim exhausted'));

    const orchestrator = new LLMOrchestratorImpl({
      primary: createProviderConfig('primary', 'key-p'),
      events: eventSink,
      maxAttempts: 1,
      retryDelayMs: 0,
      createAnthropicAdapter: () => primary,
    });

    await expect(orchestrator.call({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
    })).rejects.toThrow(/All LLM providers failed/);
    expect(primary.call).toHaveBeenCalledOnce();
  });
});
