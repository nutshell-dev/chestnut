/**
 * Phase 1374 sub-1: call() fallback retry symmetry
 * Reverse test ≥3项: fallback retry N attempts symmetric with primary + stream
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMAuthError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type {
  ProviderAdapter,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

function createFailingProvider(name: string, failTimes: number): ProviderAdapter {
  let callCount = 0;
  return {
    name,
    model: 'mock-model',
    async call() {
      callCount++;
      if (callCount <= failTimes) {
        throw new Error(`provider error ${callCount}`);
      }
      return {
        content: [{ type: 'text', text: 'success' }],
        stop_reason: 'end_turn',
      } as LLMResponse;
    },
    async *stream() {
      yield { type: 'text_delta', delta: 'chunk' };
      yield { type: 'done' };
    },
  };
}

describe('phase 1374 sub-1: call() fallback retry symmetry', () => {
  it('fallback gets maxAttempts retry before exhausted (symmetric with primary)', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createFailingProvider('primary', 999);
    const fallback = createFailingProvider('fallback', 999);
    const orchestrator = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: [{ name: fallback.name, apiKey: 'test', model: fallback.model, apiFormat: 'anthropic' as const }],
      maxAttempts: 3,
      retryDelayMs: 10,
      events: sink,
    });
    (orchestrator as any).primary = primary;
    (orchestrator as any).fallbacks = [fallback];
    (orchestrator as any).breakers = [
      new CircuitBreaker(5, 1000, () => {}),
      new CircuitBreaker(5, 1000, () => {}),
    ];

    await expect(orchestrator.call({})).rejects.toThrow();

    const fallbackAttemptFailed = emitted.filter(
      e => e.type === 'provider_attempt_failed' && e.provider === 'fallback'
    );
    expect(fallbackAttemptFailed.length).toBe(3);
    expect(fallbackAttemptFailed[0]).toMatchObject({ attempt: 0 });
    expect(fallbackAttemptFailed[1]).toMatchObject({ attempt: 1 });
    expect(fallbackAttemptFailed[2]).toMatchObject({ attempt: 2 });

    const fallbackRetryScheduled = emitted.filter(
      e => e.type === 'retry_scheduled' && e.provider === 'fallback'
    );
    expect(fallbackRetryScheduled.length).toBe(2);
  });

  it('fallback retries then succeeds (symmetric pattern with primary)', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createFailingProvider('primary', 999);
    const fallback = createFailingProvider('fallback', 2);
    const orchestrator = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: [{ name: fallback.name, apiKey: 'test', model: fallback.model, apiFormat: 'anthropic' as const }],
      maxAttempts: 3,
      retryDelayMs: 10,
      events: sink,
    });
    (orchestrator as any).primary = primary;
    (orchestrator as any).fallbacks = [fallback];
    (orchestrator as any).breakers = [
      new CircuitBreaker(5, 1000, () => {}),
      new CircuitBreaker(5, 1000, () => {}),
    ];

    const result = await orchestrator.call({});
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'success' });

    const fallbackAttemptFailed = emitted.filter(
      e => e.type === 'provider_attempt_failed' && e.provider === 'fallback'
    );
    expect(fallbackAttemptFailed.length).toBe(2);

    const fallbackRetryScheduled = emitted.filter(
      e => e.type === 'retry_scheduled' && e.provider === 'fallback'
    );
    expect(fallbackRetryScheduled.length).toBe(2);
  });

  it('fallback permanent error skips retry (symmetric with primary)', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createFailingProvider('primary', 999);
    const fallback: ProviderAdapter = {
      name: 'fallback',
      model: 'mock-model',
      async call() {
        throw new LLMAuthError('fallback', new Error('401 Unauthorized'));
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const orchestrator = new LLMOrchestratorImpl({
      primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
      fallbacks: [{ name: fallback.name, apiKey: 'test', model: fallback.model, apiFormat: 'anthropic' as const }],
      maxAttempts: 3,
      retryDelayMs: 10,
      events: sink,
    });
    (orchestrator as any).primary = primary;
    (orchestrator as any).fallbacks = [fallback];
    (orchestrator as any).breakers = [
      new CircuitBreaker(5, 1000, () => {}),
      new CircuitBreaker(5, 1000, () => {}),
    ];

    await expect(orchestrator.call({})).rejects.toThrow();

    const fallbackAttemptFailed = emitted.filter(
      e => e.type === 'provider_attempt_failed' && e.provider === 'fallback'
    );
    // Only 1 attempt because permanent error skips retry
    expect(fallbackAttemptFailed.length).toBe(1);

    const permanentSkip = emitted.filter(
      e => e.type === 'permanent_skip_retry' && e.provider === 'fallback'
    );
    expect(permanentSkip.length).toBe(1);

    const fallbackRetryScheduled = emitted.filter(
      e => e.type === 'retry_scheduled' && e.provider === 'fallback'
    );
    expect(fallbackRetryScheduled.length).toBe(0);
  });
});
