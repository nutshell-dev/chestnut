/**
 * SDK client cache invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - sdk-client-cache.test.ts
 *  - sdk-client-cache-key.test.ts
 */

import { describe, it, expect } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import type {
  ProviderAdapter,
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';

/**
 * Phase 1374 sub-3: SDK client cache (instance-lifetime)
 * Reverse test ≥3项: 2 call sequential same config + cache hit verify + audit emit
 */
describe('sdk-client-cache', () => {
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
});

/**
 * Phase 450 (review-round3 §3): SDK client cache key 含全部 endpoint-determining
 * 字段（apiFormat / model / baseUrl / apiKey hash）反向测试。
 *
 * 改前 key = ${apiFormat}:${model}:${apiKey.slice(-8)}、缺 baseUrl + 末 8 位明文。
 * 改后 key = ${apiFormat}:${model}:${baseUrl ?? 'default'}:${sha256(apiKey).slice(0,8)}。
 */
describe('sdk-client-cache-key', () => {
  function createMockSink() {
    const emitted: LLMEvent[] = [];
    const sink: LLMEventSink = {
      emit(event: LLMEvent) { emitted.push(event); },
    };
    return { sink, emitted };
  }

  describe('SDK client cache key (phase 450 review)', () => {
    it('不同 baseUrl 不共享 client（同 apiFormat+model+apiKey）', () => {
      const { sink, emitted } = createMockSink();
      new LLMOrchestratorImpl({
        primary: { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1' },
        fallbacks: [
          { name: 'p2', apiKey: 'key-abc', model: 'm1', apiFormat: 'openai', baseUrl: 'https://my-proxy.example/v1' },
        ],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      // 改前会 cache_hit（key 不含 baseUrl）；改后 2 miss
      const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
      const hits = emitted.filter(e => e.type === 'sdk_client_cache_hit');
      expect(misses.length).toBe(2);
      expect(hits.length).toBe(0);
    });

    it('不同 apiKey 不共享 client（hash 区分末位 collision）', () => {
      const { sink, emitted } = createMockSink();
      // 两个末 8 位相同的 apiKey、前缀不同 → 改前 key 同（slice(-8)）、改后 hash 不同
      new LLMOrchestratorImpl({
        primary: { name: 'p1', apiKey: 'aaaaaaaa-coll-1234', model: 'm1', apiFormat: 'openai' },
        fallbacks: [
          { name: 'p2', apiKey: 'bbbbbbbb-coll-1234', model: 'm1', apiFormat: 'openai' },
        ],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
      expect(misses.length).toBe(2);
    });

    it('同 cfg（apiFormat+model+baseUrl+apiKey）复用 cache：1 miss + N-1 hit', () => {
      const { sink, emitted } = createMockSink();
      const cfg = { name: 'p', apiKey: 'k', model: 'm', apiFormat: 'anthropic' as const, baseUrl: 'https://x.com' };
      new LLMOrchestratorImpl({
        primary: cfg,
        fallbacks: [cfg, cfg, cfg],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
      const hits = emitted.filter(e => e.type === 'sdk_client_cache_hit');
      expect(misses.length).toBe(1);
      expect(hits.length).toBe(3);
    });

    it('Phase 899: 不同 name 不共享 client（同 apiFormat+model+baseUrl+apiKey）', () => {
      const { sink, emitted } = createMockSink();
      new LLMOrchestratorImpl({
        primary: { name: 'p1', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' },
        fallbacks: [
          { name: 'p2', apiKey: 'key-abc', model: 'm1', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' },
        ],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      // 改前 name 不参与 key；改后不同 name → 2 miss
      const misses = emitted.filter(e => e.type === 'sdk_client_cache_miss');
      const hits = emitted.filter(e => e.type === 'sdk_client_cache_hit');
      expect(misses.length).toBe(2);
      expect(hits.length).toBe(0);
    });
  });
});
