/**
 * Phase 1324 C.2: orchestrator call() retry path provider_attempt_failed emit
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
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

describe('phase 1324 C.2: call() retry path provider_attempt_failed emit', () => {
  it('3 retries all fail → provider_attempt_failed emitted 3 times + 1 retry_scheduled per retry', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createFailingProvider('primary', 999);
    const orchestrator = new LLMOrchestratorImpl({
      primary: { provider: 'mock', model: 'mock-model' },
      maxAttempts: 3,
      retryDelayMs: 10,
      events: sink,
    });
    // Override primary with mock
    (orchestrator as any).primary = primary;
    (orchestrator as any).breakers = [new CircuitBreaker(5, 1000, () => {})];

    await expect(orchestrator.call({})).rejects.toThrow();

    const attemptFailedEvents = emitted.filter(e => e.type === 'provider_attempt_failed');
    expect(attemptFailedEvents.length).toBe(3);
    expect(attemptFailedEvents[0]).toMatchObject({
      type: 'provider_attempt_failed',
      provider: 'primary',
      attempt: 0,
      error: 'provider error 1',
    });
    expect(attemptFailedEvents[1]).toMatchObject({
      type: 'provider_attempt_failed',
      provider: 'primary',
      attempt: 1,
      error: 'provider error 2',
    });
    expect(attemptFailedEvents[2]).toMatchObject({
      type: 'provider_attempt_failed',
      provider: 'primary',
      attempt: 2,
      error: 'provider error 3',
    });

    // Each failed attempt (except last) triggers retry_scheduled
    const retryScheduledEvents = emitted.filter(e => e.type === 'retry_scheduled');
    expect(retryScheduledEvents.length).toBe(2);
  });

  it('1 fail then success → 1 provider_attempt_failed + 1 retry_scheduled', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createFailingProvider('primary', 1);
    const orchestrator = new LLMOrchestratorImpl({
      primary: { provider: 'mock', model: 'mock-model' },
      maxAttempts: 3,
      retryDelayMs: 10,
      events: sink,
    });
    (orchestrator as any).primary = primary;
    (orchestrator as any).breakers = [new CircuitBreaker(5, 1000, () => {})];

    const result = await orchestrator.call({});
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'success' });

    const attemptFailedEvents = emitted.filter(e => e.type === 'provider_attempt_failed');
    expect(attemptFailedEvents.length).toBe(1);
    expect(attemptFailedEvents[0]).toMatchObject({
      type: 'provider_attempt_failed',
      provider: 'primary',
      attempt: 0,
    });

    const retryScheduledEvents = emitted.filter(e => e.type === 'retry_scheduled');
    expect(retryScheduledEvents.length).toBe(1);
  });

  it('provider_attempt_failed includes errorClass + userActionHint fields (parity with stream())', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createFailingProvider('primary', 1);
    const orchestrator = new LLMOrchestratorImpl({
      primary: { provider: 'mock', model: 'mock-model' },
      maxAttempts: 2,
      retryDelayMs: 10,
      events: sink,
    });
    (orchestrator as any).primary = primary;
    (orchestrator as any).breakers = [new CircuitBreaker(5, 1000, () => {})];

    await orchestrator.call({});

    const attemptFailedEvents = emitted.filter(e => e.type === 'provider_attempt_failed');
    expect(attemptFailedEvents.length).toBe(1);
    expect(attemptFailedEvents[0]).toHaveProperty('errorClass');
    expect(attemptFailedEvents[0]).toHaveProperty('userActionHint');
  });
});
