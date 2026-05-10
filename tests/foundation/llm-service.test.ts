/**
 * LLMOrchestrator stream failover 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import type { ProviderAdapter, StreamChunk, LLMEventSink, LLMEvent } from '../../src/foundation/llm-orchestrator/types.js';
import { LLMError, LLMAllProvidersFailedError, LLMTimeoutError } from '../../src/types/errors.js';

// Mock provider factory

const noopSink: LLMEventSink = { emit: () => {} };

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}
function createMockProvider(name: string, streamImpl?: () => AsyncGenerator<StreamChunk>): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call() {
      return {
        content: [{ type: 'text', text: `Response from ${name}` }],
        stop_reason: 'end_turn',
      };
    },
    stream: streamImpl 
      ? streamImpl 
      : async function* () {
          yield { type: 'text_delta', delta: `Chunk from ${name}` };
          yield { type: 'done' };
        },
  };
}

// Mock createProvider to inject our mocks
vi.mock('../../src/foundation/llm-provider/anthropic.js', () => ({
  AnthropicAdapter: class MockAnthropicAdapter {
    name = 'mock-anthropic';
    model = 'mock-model';
    constructor(public config: any) {}
    async call() {
      return {
        content: [{ type: 'text', text: 'mock response' }],
        stop_reason: 'end_turn',
      };
    }
    async *stream() {
      yield { type: 'text_delta', delta: 'mock chunk' };
      yield { type: 'done' };
    }
  },
}));

describe('LLMOrchestratorImpl - stream failover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should yield chunks from primary when successful', async () => {
    const primary = createMockProvider('primary', async function* () {
      yield { type: 'text_delta', delta: 'Hello' };
      yield { type: 'text_delta', delta: ' World' };
      yield { type: 'done' };
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    
    // Replace internal provider with mock
    (service as any).primary = primary;

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: 'text_delta', delta: 'Hello' });
    expect(chunks[1]).toEqual({ type: 'text_delta', delta: ' World' });
    expect(chunks[2]).toEqual({ type: 'done' });
  });

  it('should failover to fallback when primary fails before any chunk', async () => {
    const primary = createMockProvider('primary', async function* () {
      throw new Error('Primary connection failed');  // 无 yield，直接抛
    });

    const fallback = createMockProvider('fallback', async function* () {
      yield { type: 'text_delta', delta: 'Fallback chunk 1' };
      yield { type: 'text_delta', delta: 'Fallback chunk 2' };
      yield { type: 'done' };
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });

    // Replace internal providers with mocks
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    // primary 失败会发一个 provider_failed 通知 chunk，随后 fallback 输出真实流
    expect(chunks).toHaveLength(4);
    expect(chunks[0].type).toBe('provider_failed');
    expect((chunks[0] as { provider?: string }).provider).toBe('primary');
    expect(chunks[1]).toEqual({ type: 'text_delta', delta: 'Fallback chunk 1' });
    expect(chunks[2]).toEqual({ type: 'text_delta', delta: 'Fallback chunk 2' });
    expect(chunks[3]).toEqual({ type: 'done' });

    // currentProviderIndex !== -1 means using fallback
    expect((service as any).currentProviderIndex).not.toBe(-1);
  });

  it('should throw original error when no fallback available', async () => {
    const primary = createMockProvider('primary', async function* () {
      throw new Error('Primary connection failed');  // 无 yield，直接抛
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    
    // Replace internal provider with mock (no fallback)
    (service as any).primary = primary;
    (service as any).fallback = undefined;

    const chunks: StreamChunk[] = [];
    let caughtError: Error | undefined;

    try {
      for await (const chunk of service.stream({ messages: [] })) {
        chunks.push(chunk);
      }
    } catch (err) {
      caughtError = err as Error;
    }

    // 单独 provider 失败时会 yield 一条 provider_failed 通知，再抛出汇总错误
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('provider_failed');
    expect((chunks[0] as { provider?: string }).provider).toBe('primary');

    // Should throw with an error indicating all providers failed
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain('All LLM providers failed');
  });

  it('should yield reset and failover after partial yield on mid-stream error (H4)', async () => {
    const primary = createMockProvider('primary', async function* () {
      yield { type: 'text_delta', delta: 'partial' } as StreamChunk;
      throw new Error('mid-stream disconnect');
    });

    const fallback = createMockProvider('fallback', async function* () {
      yield { type: 'text_delta', delta: 'fallback' } as StreamChunk;
      yield { type: 'done' } as StreamChunk;
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 2,   // 即使有重试机会也不应重试 mid-stream
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const received: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      received.push(chunk);
    }

    // 收到 partial chunk、reset chunk，然后 failover 到 fallback
    expect(received.some(c => c.type === 'text_delta' && c.delta === 'partial')).toBe(true);
    const resetChunk = received.find(c => c.type === 'reset');
    expect(resetChunk).toBeDefined();
    expect(resetChunk).toMatchObject({ provider: 'primary' });
    expect(received.some(c => c.type === 'text_delta' && c.delta === 'fallback')).toBe(true);
    expect(received.some(c => c.type === 'done')).toBe(true);
  });

  it('should retry same provider before first chunk if no chunks yielded (H4)', async () => {
    let attempt = 0;
    const primary = createMockProvider('primary', async function* () {
      attempt++;
      if (attempt === 1) throw new Error('transient connection error');  // 第一次无 yield
      yield { type: 'text_delta', delta: 'retry ok' } as StreamChunk;
      yield { type: 'done' } as StreamChunk;
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 2,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [];

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    expect(attempt).toBe(2);  // 重试了一次
    expect(chunks.some(c => 'delta' in c && c.delta === 'retry ok')).toBe(true);
  });

  // Phase 20: getProviderInfo()
  it('should getProviderInfo() return isFallback=false when primary succeeds', async () => {
    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test-model' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = createMockProvider('primary');
    (service as any).fallbacks = [];

    await service.call({ messages: [] });

    const info = service.getProviderInfo()!;
    expect(info.isFallback).toBe(false);
    expect(info.name).toBe('primary');
  });

  it('should getProviderInfo() return isFallback=true after fallback takes over', async () => {
    const badPrimary = createMockProvider('bad-primary');
    (badPrimary as any).call = async () => { throw new Error('primary failed'); };

    const goodFallback = createMockProvider('fb');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'p', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fb', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = badPrimary;
    (service as any).fallbacks = [goodFallback];

    await service.call({ messages: [] });

    const info = service.getProviderInfo()!;
    expect(info.isFallback).toBe(true);
    expect(info.name).toBe('fb');
  });

  it('should throw if stream not supported', async () => {
    const primary = {
      name: 'no-stream-provider',
      model: 'test',
      async call() {
        return { content: [], stop_reason: 'end_turn' };
      },
      // No stream method
    } as any;

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    
    (service as any).primary = primary;

    let caughtError: Error | undefined;
    try {
      for await (const chunk of service.stream({ messages: [] })) {
        // should not reach here
      }
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeInstanceOf(LLMError);
    expect(caughtError!.message).toContain('All LLM providers failed');
  });

  it('should yield reset chunk and failover to fallback on mid-stream LLMTimeoutError', async () => {
    const primary = createMockProvider('primary', async function* () {
      yield { type: 'text_delta', delta: 'partial text' } as StreamChunk;
      throw new LLMTimeoutError('primary', 60000);
    });

    const fallback = createMockProvider('fallback', async function* () {
      yield { type: 'text_delta', delta: 'fallback response' } as StreamChunk;
      yield { type: 'done' } as StreamChunk;
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    // Should have: partial text, reset chunk, fallback response, done
    expect(chunks.some(c => c.type === 'reset')).toBe(true);
    const resetChunk = chunks.find(c => c.type === 'reset')!;
    expect(resetChunk.provider).toBe('primary');
    expect(resetChunk.timeoutMs).toBe(60000);
    expect(chunks.some(c => 'delta' in c && c.delta === 'fallback response')).toBe(true);
  });

  it('should throw LLMAllProvidersFailedError when all providers time out mid-stream', async () => {
    const primary = createMockProvider('primary', async function* () {
      yield { type: 'text_delta', delta: 'partial' } as StreamChunk;
      throw new LLMTimeoutError('primary', 60000);
    });

    const fallback = createMockProvider('fallback', async function* () {
      yield { type: 'text_delta', delta: 'fallback partial' } as StreamChunk;
      throw new LLMTimeoutError('fallback', 60000);
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    let caughtError: Error | undefined;
    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of service.stream({ messages: [] })) {
        chunks.push(chunk);
      }
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeInstanceOf(LLMAllProvidersFailedError);
    // Both reset chunks should have been yielded before final error
    expect(chunks.filter(c => c.type === 'reset')).toHaveLength(2);
  });

  it('should try primary again on next call even if previous streaming used fallback', async () => {
    let primaryAttempts = 0;

    const primary = createMockProvider('primary', async function* () {
      primaryAttempts++;
      if (primaryAttempts === 1) {
        throw new Error('primary down');  // 第一次失败
      }
      yield { type: 'text_delta', delta: 'primary back' } as StreamChunk;
      yield { type: 'done' } as StreamChunk;
    });

    const fallback = createMockProvider('fallback', async function* () {
      yield { type: 'text_delta', delta: 'fallback ok' } as StreamChunk;
      yield { type: 'done' } as StreamChunk;
    });

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    // First call: primary fails, fallback succeeds
    const chunks1: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) chunks1.push(chunk);
    expect(chunks1.some(c => 'delta' in c && c.delta === 'fallback ok')).toBe(true);

    // Second call: primary must be tried again (regression test for startIndex bug)
    const chunks2: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) chunks2.push(chunk);
    expect(primaryAttempts).toBe(2);  // old bug: primary was skipped, this would be 1
    expect(chunks2.some(c => 'delta' in c && c.delta === 'primary back')).toBe(true);
  });

  describe('Orchestrator getProviderInfo + healthCheck (phase 616)', () => {
    it('全失败 throw 后 getProviderInfo 返 null（lastSuccessProvider 不更新）', async () => {
      const badPrimary = createMockProvider('p');
      (badPrimary as any).call = async () => { throw new Error('primary failed'); };

      const service = new LLMOrchestratorImpl({
        primary: { name: 'p', apiKey: 'test', model: 'test' },
        fallbacks: [],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = badPrimary;

      await expect(service.call({ messages: [] })).rejects.toThrow();
      expect(service.getProviderInfo()).toBeNull();
    });

    it('成功 call 后 getProviderInfo 返成功 adapter info', async () => {
      const service = new LLMOrchestratorImpl({
        primary: { name: 'primary', apiKey: 'test', model: 'foo' },
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = createMockProvider('primary');

      await service.call({ messages: [] });
      expect(service.getProviderInfo()).toEqual({ name: 'primary', model: 'mock-model', isFallback: false });
    });

    it('mid-stream failover 后再失败 / getProviderInfo 仍返之前成功 provider info', async () => {
      const badPrimary = createMockProvider('p');
      (badPrimary as any).call = async () => { throw new Error('primary failed'); };
      const goodFallback = createMockProvider('fb');

      const service = new LLMOrchestratorImpl({
        primary: { name: 'p', apiKey: 'test', model: 'test' },
        fallbacks: [{ name: 'fb', apiKey: 'test', model: 'test' }],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: noopSink,
      });
      (service as any).primary = badPrimary;
      (service as any).fallbacks = [goodFallback];

      await service.call({ messages: [] });
      const beforeFail = service.getProviderInfo();
      expect(beforeFail).toEqual({ name: 'fb', model: 'mock-model', isFallback: true });

      // Now make fallback fail too
      (service as any).fallbacks[0].call = async () => { throw new Error('fallback failed'); };
      await expect(service.call({ messages: [] })).rejects.toThrow();
      expect(service.getProviderInfo()).toEqual(beforeFail);
    });

    it('healthCheck primary fail / fallback success → return true + emit healthcheck_failed for primary only', async () => {
      const badPrimary = createMockProvider('p');
      (badPrimary as any).call = async () => { throw new Error('primary failed'); };
      const goodFallback = createMockProvider('fb');

      const { sink, emitted } = createMockSink();
      const service = new LLMOrchestratorImpl({
        primary: { name: 'p', apiKey: 'test', model: 'test' },
        fallbacks: [{ name: 'fb', apiKey: 'test', model: 'test' }],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      (service as any).primary = badPrimary;
      (service as any).fallbacks = [goodFallback];

      expect(await service.healthCheck()).toBe(true);
      const failedEvents = emitted.filter((e: any) => e.type === 'healthcheck_failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].provider).toBe('p');
    });

    it('healthCheck 全失败 → return false + emit healthcheck_failed for each provider', async () => {
      const badPrimary = createMockProvider('p');
      (badPrimary as any).call = async () => { throw new Error('primary failed'); };
      const badFallback1 = createMockProvider('fb1');
      (badFallback1 as any).call = async () => { throw new Error('fb1 failed'); };
      const badFallback2 = createMockProvider('fb2');
      (badFallback2 as any).call = async () => { throw new Error('fb2 failed'); };

      const { sink, emitted } = createMockSink();
      const service = new LLMOrchestratorImpl({
        primary: { name: 'p', apiKey: 'test', model: 'test' },
        fallbacks: [{ name: 'fb1', apiKey: 'test', model: 'test' }, { name: 'fb2', apiKey: 'test', model: 'test' }],
        maxAttempts: 1,
        retryDelayMs: 0,
        events: sink,
      });
      (service as any).primary = badPrimary;
      (service as any).fallbacks = [badFallback1, badFallback2];

      expect(await service.healthCheck()).toBe(false);
      const failedEvents = emitted.filter((e: any) => e.type === 'healthcheck_failed');
      expect(failedEvents).toHaveLength(3);
    });
  });
});

// Phase 20: Circuit Breaker
describe('LLMOrchestratorImpl - circuit breaker', () => {
  it('should skip primary after threshold failures (circuit opens)', async () => {
    // threshold=2: primary fails twice → breaker opens → 3rd call skips primary entirely
    let primaryCallCount = 0;
    const failingPrimary: ProviderAdapter = {
      name: 'primary',
      model: 'x',
      async call() { primaryCallCount++; throw new Error('primary down'); },
      async *stream() { throw new Error('primary down'); },
    };

    const goodFallback = createMockProvider('fallback');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'p', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'fb', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60000 },
      events: noopSink,
    });
    (service as any).primary = failingPrimary;
    (service as any).fallbacks = [goodFallback];

    // Calls 1 and 2: primary fails, fallback saves — breaker accumulates 2 failures
    await service.call({ messages: [] });
    await service.call({ messages: [] });
    expect(primaryCallCount).toBe(2);

    // Call 3: breaker is now open → primary is skipped entirely
    await service.call({ messages: [] });
    expect(primaryCallCount).toBe(2); // primary NOT called on 3rd attempt
  });

  it('should allow probe in half-open state after resetTimeoutMs', async () => {
    let primaryFailCount = 0;
    let primaryShouldFail = true;
    const probePrimary: ProviderAdapter = {
      name: 'primary',
      model: 'x',
      async call() {
        if (primaryShouldFail) {
          primaryFailCount++;
          throw new Error('down');
        }
        return { content: [{ type: 'text' as const, text: 'ok' }], stop_reason: 'end_turn' as const };
      },
      async *stream() { yield { type: 'done' as const }; },
    };

    const goodFallback = createMockProvider('fb');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'p', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'fb', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 50 },
      events: noopSink,
    });
    (service as any).primary = probePrimary;
    (service as any).fallbacks = [goodFallback];

    // Open the breaker
    await service.call({ messages: [] }); // failure 1
    await service.call({ messages: [] }); // failure 2 → breaker opens
    expect(primaryFailCount).toBe(2);

    // Wait past resetTimeoutMs → transitions to half-open on next isOpen() check
    await new Promise(r => setTimeout(r, 60));
    primaryShouldFail = false;

    // Half-open probe: primary should be attempted and succeed → breaker closes
    await service.call({ messages: [] });
    expect(primaryFailCount).toBe(2); // no new failures (shouldFail=false)

    // Provider should have returned to primary
    const info = service.getProviderInfo()!;
    expect(info.isFallback).toBe(false);
  }, 2000);

  it('should emit breaker_half_open event when transitioning open → half-open', async () => {
    const events: any[] = [];
    const eventSink = { emit: (e: any) => events.push(e) };

    let callCount = 0;
    const failingPrimary: ProviderAdapter = {
      name: 'primary',
      model: 'x',
      async call() { callCount++; throw new Error('down'); },
      async *stream() { throw new Error('down'); },
    };
    const goodFallback = createMockProvider('fb');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'p', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'fb', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 50 },
      events: eventSink,
    });
    (service as any).primary = failingPrimary;
    (service as any).fallbacks = [goodFallback];

    // Open the breaker
    await service.call({ messages: [] });
    await service.call({ messages: [] });

    // Wait past resetTimeoutMs
    await new Promise(r => setTimeout(r, 60));

    // Next call triggers isOpen() → half-open transition
    await service.call({ messages: [] });

    const halfOpenEvents = events.filter(e => e.type === 'breaker_half_open');
    expect(halfOpenEvents.length).toBe(1);
    expect(halfOpenEvents[0].provider).toBe('p');
  }, 2000);

  it('should emit breaker_closed event when probe succeeds in half-open state', async () => {
    const events: any[] = [];
    const eventSink = { emit: (e: any) => events.push(e) };

    let primaryShouldFail = true;
    const probePrimary: ProviderAdapter = {
      name: 'primary',
      model: 'x',
      async call() {
        if (primaryShouldFail) throw new Error('down');
        return { content: [{ type: 'text' as const, text: 'ok' }], stop_reason: 'end_turn' as const };
      },
      async *stream() { yield { type: 'done' as const }; },
    };
    const goodFallback = createMockProvider('fb');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'p', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'fb', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 50 },
      events: eventSink,
    });
    (service as any).primary = probePrimary;
    (service as any).fallbacks = [goodFallback];

    // Open the breaker
    await service.call({ messages: [] });
    await service.call({ messages: [] });

    // Wait past resetTimeoutMs → half-open
    await new Promise(r => setTimeout(r, 60));
    primaryShouldFail = false;

    // Probe succeeds → half-open → closed
    await service.call({ messages: [] });

    const closedEvents = events.filter(e => e.type === 'breaker_closed');
    expect(closedEvents.length).toBe(1);
    expect(closedEvents[0].provider).toBe('p');
  }, 2000);

  it('should throw LLMAllProvidersFailedError when all providers fail', async () => {
    const badPrimary: ProviderAdapter = {
      name: 'p1', model: 'x',
      async call() { throw new Error('p1 down'); },
      async *stream() { throw new Error('p1 down'); },
    };
    const badFallback: ProviderAdapter = {
      name: 'p2', model: 'x',
      async call() { throw new Error('p2 down'); },
      async *stream() { throw new Error('p2 down'); },
    };

    const service = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'p2', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = badPrimary;
    (service as any).fallbacks = [badFallback];

    await expect(service.call({ messages: [] }))
      .rejects.toBeInstanceOf(LLMAllProvidersFailedError);
  });
});


describe('LLMOrchestratorImpl - external abort signal', () => {
  it('throws AbortError without trying next provider when signal is already aborted', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const ac = new AbortController();
    ac.abort();

    await expect(async () => {
      for await (const _ of service.stream({ messages: [], signal: ac.signal })) {}
    }).rejects.toThrow(/aborted/i);
  });

  it('throws AbortError from mid-stream without yielding reset/provider_failed', async () => {
    const primary = createMockProvider('primary', async function* () {
      yield { type: 'text_delta', delta: 'hi' } as StreamChunk;
      const err = new Error('Execution aborted');
      err.name = 'AbortError';
      throw err;
    });
    const fallbackStream = vi.fn(async function* () {
      yield { type: 'done' } as StreamChunk;
    });
    const fallback = createMockProvider('fallback', fallbackStream);

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const iter = service.stream({ messages: [] });
    const first = await iter.next();
    expect(first.value).toEqual({ type: 'text_delta', delta: 'hi' });

    await expect(iter.next()).rejects.toThrow(/aborted/i);
    expect(fallbackStream).not.toHaveBeenCalled();
  });


  it('aborts immediately during call() backoff delay without waiting', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'test',
      async call() { throw new Error('transient'); },
      async *stream() { throw new Error('n/a'); },
    };

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 3,
      retryDelayMs: 10_000,
      events: noopSink,
    });
    (service as any).primary = primary;

    const ac = new AbortController();

    setTimeout(() => ac.abort(), 50);

    await expect(service.call({ messages: [], signal: ac.signal }))
      .rejects.toThrow(/aborted/i);
  });

  it('aborts immediately during stream() backoff delay without waiting', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'test',
      async call() { return { content: [], stop_reason: 'end_turn' }; },
      async *stream() {
        throw new Error('transient');
      },
    };

    const service = new LLMOrchestratorImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 3,
      retryDelayMs: 10_000,
      events: noopSink,
    });
    (service as any).primary = primary;

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    await expect(async () => {
      for await (const _ of service.stream({ messages: [], signal: ac.signal })) {}
    }).rejects.toThrow(/aborted/i);
  });
});

describe('LLMOrchestratorImpl - events (Phase 254)', () => {
  it('emits provider_attempt_failed when primary throws', async () => {
    const { sink, emitted } = createMockSink();
    const failingAdapter = createMockProvider('p1');
    (failingAdapter as any).call = async () => { throw new Error('timeout'); };
    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'test', model: 'test' },
      fallbacks: [],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = failingAdapter;

    await expect(svc.call({ messages: [] })).rejects.toThrow();
    expect(emitted.some(e => e.type === 'provider_attempt_failed' || e.type === 'provider_exhausted')).toBe(true);
  });

  it('emits retry_scheduled with correct backoffMs', async () => {
    const { sink, emitted } = createMockSink();
    let calls = 0;
    const adapter = createMockProvider('p1');
    (adapter as any).call = async () => {
      if (calls++ < 1) throw new Error('transient');
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
    };
    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'test', model: 'test' },
      fallbacks: [],
      maxAttempts: 2,
      retryDelayMs: 100,
      events: sink,
    });
    (svc as any).primary = adapter;

    await svc.call({ messages: [] });
    const retryEvent = emitted.find(e => e.type === 'retry_scheduled');
    expect(retryEvent).toBeDefined();
    expect((retryEvent as any).backoffMs).toBe(100);
  });

  it('emits provider_exhausted + fallback_switched when primary exhausted', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createMockProvider('p1');
    (primary as any).call = async () => { throw new Error('fail'); };
    const fallback = createMockProvider('fb1');
    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fb1', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = primary;
    (svc as any).fallbacks = [fallback];

    await svc.call({ messages: [] });
    expect(emitted.some(e => e.type === 'provider_exhausted')).toBe(true);
    expect(emitted.some(e => e.type === 'fallback_switched')).toBe(true);
  });

  it('emits healthcheck_failed on healthCheck error', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createMockProvider('p1');
    (primary as any).call = async () => { throw new Error('health-fail'); };
    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'test', model: 'test' },
      fallbacks: [],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = primary;

    const result = await svc.healthCheck();
    expect(result).toBe(false);
    expect(emitted.some(e => e.type === 'healthcheck_failed')).toBe(true);
  });

  it('emits stream_reset on mid-stream error', async () => {
    const { sink, emitted } = createMockSink();
    const primary = createMockProvider('p1', async function* () {
      yield { type: 'text_delta', delta: 'hi' };
      throw new Error('mid-stream-fail');
    });
    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'test', model: 'test' },
      fallbacks: [],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = primary;

    const chunks: any[] = [];
    try {
      for await (const chunk of svc.stream({ messages: [] })) {
        chunks.push(chunk);
      }
    } catch {
      // expected: no fallback available
    }
    expect(emitted.some(e => e.type === 'stream_reset')).toBe(true);
  });
});

function makeSlowAdapter(name: string): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call(opts) {
      await new Promise<never>((_, reject) => {
        if (opts.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      throw new Error('unreachable');
    },
    async *stream(opts) {
      await new Promise<never>((_, reject) => {
        if (opts.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      throw new Error('unreachable');
    },
  };
}

describe('LLMOrchestratorImpl - idle failover', () => {
  it('idle timeout on P1 → failover to P2 → success', async () => {
    const { sink, emitted } = createMockSink();
    const p1 = makeSlowAdapter('p1');
    const p2 = createMockProvider('p2', async function* () {
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done' };
    });

    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k', model: 'm' },
      fallbacks: [{ name: 'p2', apiKey: 'k', model: 'm' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = p1;
    (svc as any).fallbacks = [p2];

    const chunks: StreamChunk[] = [];
    for await (const chunk of svc.stream({ messages: [], idleTimeoutMs: 50 })) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'text_delta')).toBe(true);
    expect(emitted.filter(e => e.type === 'idle_failover_triggered').length).toBe(1);
    const ev = emitted.find(e => e.type === 'idle_failover_triggered') as any;
    expect(ev.provider).toBe('p1');
    expect(ev.ms).toBe(50);
  });

  it('all providers idle timeout → LLMAllProvidersFailedError', async () => {
    const { sink, emitted } = createMockSink();
    const p1 = makeSlowAdapter('p1');
    const p2 = makeSlowAdapter('p2');

    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k', model: 'm' },
      fallbacks: [{ name: 'p2', apiKey: 'k', model: 'm' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = p1;
    (svc as any).fallbacks = [p2];

    await expect(async () => {
      for await (const _ of svc.stream({ messages: [], idleTimeoutMs: 50 })) {}
    }).rejects.toThrow(LLMAllProvidersFailedError);

    expect(emitted.filter(e => e.type === 'idle_failover_triggered').length).toBe(2);
  });

  it('user abort during idle failover → immediate throw, P2 not tried', async () => {
    const { sink, emitted } = createMockSink();
    const p1 = makeSlowAdapter('p1');
    let p2Called = false;
    const p2: ProviderAdapter = {
      name: 'p2',
      model: 'm',
      async call() { return { content: [], stop_reason: 'end_turn' }; },
      async *stream() { p2Called = true; yield { type: 'done' }; },
    };

    const svc = new LLMOrchestratorImpl({
      primary: { name: 'p1', apiKey: 'k', model: 'm' },
      fallbacks: [{ name: 'p2', apiKey: 'k', model: 'm' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (svc as any).primary = p1;
    (svc as any).fallbacks = [p2];

    const userCtrl = new AbortController();
    setTimeout(() => userCtrl.abort(), 20);

    await expect(async () => {
      for await (const _ of svc.stream({ messages: [], signal: userCtrl.signal, idleTimeoutMs: 200 })) {}
    }).rejects.toThrow();

    expect(p2Called).toBe(false);
    expect(emitted.filter(e => e.type === 'idle_failover_triggered').length).toBe(0);
  });
});


describe('LLMOrchestratorImpl - context_exceeded failover (Phase 408)', () => {
  it('should failover when first provider returns context_window_exceeded done chunk', async () => {
    const mockProvider1 = createMockProvider('mock1', function* () {
      yield { type: 'done', stopReason: 'model_context_window_exceeded' };
    });
    const mockProvider2 = createMockProvider('mock2', function* () {
      yield { type: 'text_delta', delta: 'success' };
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const service = new LLMOrchestratorImpl({
      primary: { name: 'mock1', apiKey: 'k', model: 'm' },
      fallbacks: [{ name: 'mock2', apiKey: 'k', model: 'm' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = mockProvider1;
    (service as any).fallbacks = [mockProvider2];

    const chunks: StreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: 'reset', provider: 'mock1' });
    expect(chunks.find(c => c.type === 'done' && c.stopReason === 'end_turn')).toBeDefined();
  });

  it('should throw when all providers return context_window_exceeded', async () => {
    const mockProvider1 = createMockProvider('mock1', function* () {
      yield { type: 'done', stopReason: 'model_context_window_exceeded' };
    });
    const mockProvider2 = createMockProvider('mock2', function* () {
      yield { type: 'done', stopReason: 'context_length_exceeded' };
    });
    const service = new LLMOrchestratorImpl({
      primary: { name: 'mock1', apiKey: 'k', model: 'm' },
      fallbacks: [{ name: 'mock2', apiKey: 'k', model: 'm' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: noopSink,
    });
    (service as any).primary = mockProvider1;
    (service as any).fallbacks = [mockProvider2];

    await expect(async () => {
      for await (const _ of service.stream({ messages: [] })) {}
    }).rejects.toThrow(/context_window_exceeded.*Reduce/);
  });

  it('should emit context_exceeded_failover event', async () => {
    const { sink, emitted } = createMockSink();
    const mockProvider1 = createMockProvider('mock1', function* () {
      yield { type: 'done', stopReason: 'model_context_window_exceeded' };
    });
    const mockProvider2 = createMockProvider('mock2', function* () {
      yield { type: 'text_delta', delta: 'success' };
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const service = new LLMOrchestratorImpl({
      primary: { name: 'mock1', apiKey: 'k', model: 'm' },
      fallbacks: [{ name: 'mock2', apiKey: 'k', model: 'm' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
    });
    (service as any).primary = mockProvider1;
    (service as any).fallbacks = [mockProvider2];

    for await (const _ of service.stream({ messages: [] })) {}

    expect(emitted).toContainEqual({
      type: 'context_exceeded_failover',
      provider: 'mock1',
      stopReason: 'model_context_window_exceeded',
    });
  });
});
