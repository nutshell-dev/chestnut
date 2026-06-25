import { describe, it, expect, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { ContextTrimExhaustedError } from '../../../src/core/context_manager/errors.js';
import type { LLMEventSink } from '../../../src/foundation/llm-orchestrator/types.js';

function createMockProvider(name: string, apiKey: string) {
  return {
    name,
    model: 'test-model',
    apiKey,
    apiFormat: 'openai',
    maxTokens: 1000,
    temperature: 0.7,
    timeoutMs: 30000,
    call: vi.fn(),
    stream: vi.fn(),
    getProviderInfo: vi.fn().mockReturnValue({ name, model: 'test-model', isFallback: false }),
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };
}

describe('orchestrator failover on ContextTrimExhaustedError', () => {
  it('switches to fallback when primary throws ContextTrimExhaustedError', async () => {
    const events: Array<Record<string, unknown>> = [];
    const eventSink: LLMEventSink = {
      emit: (e: Record<string, unknown>) => { events.push(e); },
    };

    const primary = createMockProvider('primary', 'key-p');
    const fallback = createMockProvider('fallback', 'key-f');

    primary.call.mockRejectedValue(new ContextTrimExhaustedError('trim exhausted'));
    fallback.call.mockResolvedValue({
      content: [{ type: 'text', text: 'fallback response' }],
      stop_reason: 'end_turn',
      model: 'fallback-model',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const orchestrator = new LLMOrchestratorImpl({
      primary: primary as unknown as Parameters<typeof LLMOrchestratorImpl.prototype.constructor>[0]['primary'],
      fallbacks: [fallback as unknown as Parameters<typeof LLMOrchestratorImpl.prototype.constructor>[0]['primary']],
      events: eventSink,
      maxAttempts: 1,
      retryDelayMs: 0,
    });

    // Verify fallback provider is distinct from primary
    expect((orchestrator as unknown as { fallbacks: Array<{ name: string }> }).fallbacks[0].name).toBe('fallback');

    const result = await orchestrator.call({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
    });

    expect(result.content[0]).toEqual({ type: 'text', text: 'fallback response' });
    expect(events.some(e => e.type === 'context_exceeded_failover')).toBe(true);
  });

  it('throws LLMAllProvidersFailedError when all providers exhausted', async () => {
    const eventSink: LLMEventSink = {
      emit: () => {},
    };

    const primary = createMockProvider('primary', 'key-p');

    primary.call.mockRejectedValue(new ContextTrimExhaustedError('trim exhausted'));

    const orchestrator = new LLMOrchestratorImpl({
      primary: primary as unknown as Parameters<typeof LLMOrchestratorImpl.prototype.constructor>[0]['primary'],
      events: eventSink,
      maxAttempts: 1,
      retryDelayMs: 0,
    });

    await expect(orchestrator.call({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
    })).rejects.toThrow(/All LLM providers failed/);
  });
});
