/**
 * Phase 1374 sub-3: SDK client cache (instance-lifetime)
 * Reverse test ≥3项: 2 call sequential same config + cache hit verify + audit emit
 */

import { describe, it, expect } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
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

function createMockProvider(name: string): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call() {
      return {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      } as LLMResponse;
    },
    async *stream() {
      yield { type: 'done' };
    },
  };
}

describe('phase 1374 sub-3: SDK client cache', () => {
  it('cache miss on first creation + cache hit on same config', () => {
    const { sink, emitted } = createMockSink();
    const orchestrator = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic' },
      fallbacks: [
        { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic' },
      ],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    // primary = miss, fallback = hit (same config)
    const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
    const hits = emitted.filter(e => e.type === 'sdk_client_cache_hit');
    expect(misses.length).toBe(1);
    expect(hits.length).toBe(1);
    expect(misses[0]).toMatchObject({ preset: 'anthropic', model: 'm1' });
    expect(hits[0]).toMatchObject({ preset: 'anthropic', model: 'm1' });

    // Verify same provider instance is reused
    const primary = (orchestrator as any).primary;
    const fallback = (orchestrator as any).fallbacks[0];
    expect(primary).toBe(fallback);
  });

  it('cache miss for different configs', () => {
    const { sink, emitted } = createMockSink();
    new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic' },
      fallbacks: [
        { name: 'p2', apiKey: 'key-def', model: 'm2', apiFormat: 'openai' },
      ],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });

    const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
    expect(misses.length).toBe(2);
    expect(misses[0]).toMatchObject({ preset: 'anthropic', model: 'm1' });
    expect(misses[1]).toMatchObject({ preset: 'openai', model: 'm2' });

    const hits = emitted.filter(e => e.type === 'sdk_client_cache_hit');
    expect(hits.length).toBe(0);
  });

  it('cache is instance-local (different orchestrators do not share)', () => {
    const { sink: sink1 } = createMockSink();
    const { sink: sink2 } = createMockSink();

    const orch1 = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink1,
    });

    const orch2 = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink2,
    });

    const p1 = (orch1 as any).primary;
    const p2 = (orch2 as any).primary;
    // Different orchestrator instances should have different provider objects
    // because cache is per-instance
    expect(p1).not.toBe(p2);
  });
});
