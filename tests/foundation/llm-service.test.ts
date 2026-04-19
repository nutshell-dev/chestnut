/**
 * LLMService stream failover 测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMServiceImpl } from '../../src/foundation/llm/service.js';
import type { ProviderAdapter, StreamChunk } from '../../src/foundation/llm/types.js';
import { LLMError, LLMAllProvidersFailedError, LLMTimeoutError } from '../../src/types/errors.js';

// Mock provider factory
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
vi.mock('../../src/foundation/llm/anthropic.js', () => ({
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

describe('LLMServiceImpl - stream failover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should yield chunks from primary when successful', async () => {
    const primary = createMockProvider('primary', async function* () {
      yield { type: 'text_delta', delta: 'Hello' };
      yield { type: 'text_delta', delta: ' World' };
      yield { type: 'done' };
    });

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 2,   // 即使有重试机会也不应重试 mid-stream
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 2,
      retryDelayMs: 0,
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
    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test-model' },
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    (service as any).primary = createMockProvider('primary');
    (service as any).fallbacks = [];

    await service.call({ messages: [] });

    const info = service.getProviderInfo();
    expect(info.isFallback).toBe(false);
    expect(info.name).toBe('primary');
  });

  it('should getProviderInfo() return isFallback=true after fallback takes over', async () => {
    const badPrimary = createMockProvider('bad-primary');
    (badPrimary as any).call = async () => { throw new Error('primary failed'); };

    const goodFallback = createMockProvider('fb');

    const service = new LLMServiceImpl({
      primary: { name: 'p', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fb', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    (service as any).primary = badPrimary;
    (service as any).fallbacks = [goodFallback];

    await service.call({ messages: [] });

    const info = service.getProviderInfo();
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
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
});

// Phase 20: Circuit Breaker
describe('LLMServiceImpl - circuit breaker', () => {
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

    const service = new LLMServiceImpl({
      primary: { name: 'p', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'fb', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60000 },
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

    const service = new LLMServiceImpl({
      primary: { name: 'p', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'fb', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 50 },
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
    const info = service.getProviderInfo();
    expect(info.isFallback).toBe(false);
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

    const service = new LLMServiceImpl({
      primary: { name: 'p1', apiKey: 'x', model: 'x' },
      fallbacks: [{ name: 'p2', apiKey: 'x', model: 'x' }],
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    (service as any).primary = badPrimary;
    (service as any).fallbacks = [badFallback];

    await expect(service.call({ messages: [] }))
      .rejects.toBeInstanceOf(LLMAllProvidersFailedError);
  });
});


describe('LLMServiceImpl - external abort signal', () => {
  it('throws AbortError without trying next provider when signal is already aborted', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      fallbacks: [{ name: 'fallback', apiKey: 'test', model: 'test' }],
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    (service as any).primary = primary;
    (service as any).fallbacks = [fallback];

    const iter = service.stream({ messages: [] });
    const first = await iter.next();
    expect(first.value).toEqual({ type: 'text_delta', delta: 'hi' });

    await expect(iter.next()).rejects.toThrow(/aborted/i);
    expect(fallbackStream).not.toHaveBeenCalled();
  });
});


  it('aborts immediately during call() backoff delay without waiting', async () => {
    const primary: ProviderAdapter = {
      name: 'primary',
      model: 'test',
      async call() { throw new Error('transient'); },
      async *stream() { throw new Error('n/a'); },
    };

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 3,
      retryDelayMs: 10_000,
    });
    (service as any).primary = primary;

    const ac = new AbortController();
    const start = Date.now();

    setTimeout(() => ac.abort(), 50);

    await expect(service.call({ messages: [], signal: ac.signal }))
      .rejects.toThrow(/aborted/i);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
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

    const service = new LLMServiceImpl({
      primary: { name: 'primary', apiKey: 'test', model: 'test' },
      maxAttempts: 3,
      retryDelayMs: 10_000,
    });
    (service as any).primary = primary;

    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 50);

    await expect(async () => {
      for await (const _ of service.stream({ messages: [], signal: ac.signal })) {}
    }).rejects.toThrow(/aborted/i);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });
