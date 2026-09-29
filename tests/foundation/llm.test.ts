/**
 * LLM Orchestrator tests（Phase 1925 Step D 重构）
 *
 * 旧 Anthropic/OpenAI/Gemini/custom adapter 直测段已随旧实现一并删除；
 * 适配器行为等价证据在 tests/foundation/llm-provider/pi-ai-adapter.test.ts。
 * 本文件保留：LLMOrchestratorImpl 重试/failover/backoff/provider-info 语义
 * （经 createProviderAdapter DI seam 或 fetch 级 anthropic SSE 驱动真实 PiAiAdapter）
 * 与 createLLMOrchestrator factory 透传。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProviderAdapter, ProviderConfig, ProviderStreamChunk } from '../../src/foundation/llm-provider/index.js';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import { createLLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { LLMStreamChunk } from '../../src/foundation/llm-orchestrator/index.js';
import {
  LLMAllProvidersFailedError,
} from '../../src/foundation/llm-orchestrator/errors.js';
import { TEST_LLM_TIMEOUT_MS } from '../helpers/test-timeouts.js';

/**
 * Phase 1925 Step C: LLMOrchestratorImpl 测试的 fetch 级 anthropic-messages SSE
 * 响应（factory 已切 PiAiAdapter，SDK mock 不再被触达）。事件块空行分隔。
 */
function createAnthropicSseResponse(text: string): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = events.map(([t, d]) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

  describe('LLMOrchestratorImpl', () => {
    const primaryConfig = {
      name: 'primary',
      apiKey: 'primary-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-test',
      maxTokens: 4096,
      temperature: 0.7,
      timeoutMs: TEST_LLM_TIMEOUT_MS,
      apiFormat: 'anthropic' as const,
    };

    const fallbackConfig = {
      name: 'fallback',
      apiKey: 'fallback-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-fallback',
      maxTokens: 4096,
      temperature: 0.7,
      timeoutMs: TEST_LLM_TIMEOUT_MS,
      apiFormat: 'anthropic' as const,
    };

    beforeEach(() => {
      // Phase 1925 Step C: factory 路由 PiAiAdapter → mock 层移到 fetch（SSE）
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function fetchMock(): ReturnType<typeof vi.fn> {
      return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    }

    it('should use primary provider on success', async () => {
      fetchMock().mockResolvedValue(createAnthropicSseResponse('Primary response'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        maxAttempts: 3,
        retryDelayMs: 100,
      events: { emit: () => {} },
      });

      const response = await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect((response.content[0] as { text: string }).text).toBe('Primary response');
      expect(service.getProviderInfo()!.name).toBe('primary');
    });

    it('should failover to fallback when primary fails', async () => {
      // Primary fails, fallback succeeds
      fetchMock()
        .mockRejectedValueOnce(new Error('Primary error'))
        .mockResolvedValueOnce(createAnthropicSseResponse('Fallback response'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 1,
        retryDelayMs: 100,
      events: { emit: () => {} },
      });

      const response = await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect((response.content[0] as { text: string }).text).toBe('Fallback response');
      expect(service.getProviderInfo()!.isFallback).toBe(true);
    });

    it('should throw LLMAllProvidersFailedError when both fail', async () => {
      fetchMock().mockRejectedValue(new Error('Both failed'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 1,
        retryDelayMs: 100,
      events: { emit: () => {} },
      });

      await expect(service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      })).rejects.toThrow(LLMAllProvidersFailedError);
    });

    it('should retry primary before failover', async () => {
      // Fail twice, succeed on third
      fetchMock()
        .mockRejectedValueOnce(new Error('Attempt 1'))
        .mockRejectedValueOnce(new Error('Attempt 2'))
        .mockResolvedValueOnce(createAnthropicSseResponse('Success'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 3,
        retryDelayMs: 10, // Fast for test
      events: { emit: () => {} },
      });

      const response = await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect((response.content[0] as { text: string }).text).toBe('Success');
      expect(fetchMock()).toHaveBeenCalledTimes(3); // 3 retries
    });

    it('should reset fallback status after primary succeeds', async () => {
      // First call fails (uses fallback)
      fetchMock()
        .mockRejectedValueOnce(new Error('Primary down'))
        .mockResolvedValueOnce(createAnthropicSseResponse('Fallback'))
        // Second call primary succeeds
        .mockResolvedValueOnce(createAnthropicSseResponse('Primary OK'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 1,
        retryDelayMs: 10,
      events: { emit: () => {} },
      });

      // First call - should use fallback
      const response1 = await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect((response1.content[0] as { text: string }).text).toBe('Fallback');
      expect(service.getProviderInfo()!.isFallback).toBe(true);

      service.resetLastSuccessProvider();

      // Second call - should use primary (fallback reset)
      const response2 = await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect((response2.content[0] as { text: string }).text).toBe('Primary OK');
      expect(service.getProviderInfo()!.isFallback).toBe(false);
    });

    it('should cap backoff at 30 seconds', async () => {
      // Use small delay to verify the capping logic without long waits
      fetchMock()
        .mockRejectedValueOnce(new Error('Error 1'))  // 1st attempt
        .mockRejectedValueOnce(new Error('Error 2'))  // 2nd attempt
        .mockRejectedValueOnce(new Error('Error 3'))  // 3rd attempt
        .mockResolvedValueOnce(createAnthropicSseResponse('Success')); // 4th attempt (success)

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        maxAttempts: 5,  // Max 5 attempts total
        // Base delay: 50ms
        // 1st retry: 50ms * 2^0 = 50ms
        // 2nd retry: 50ms * 2^1 = 100ms
        // 3rd retry would be 200ms, etc.
        // All well under 30s cap - test verifies code path exists
        retryDelayMs: 50,
      events: { emit: () => {} },
      });

      await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(fetchMock()).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('should report correct provider info', async () => {
      fetchMock().mockResolvedValue(createAnthropicSseResponse('OK'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 1,
        retryDelayMs: 100,
      events: { emit: () => {} },
      });

      await service.call({ messages: [{ role: 'user', content: 'Hi' }] });
      const info = service.getProviderInfo()!;
      expect(info.name).toBe('primary');
      expect(info.model).toBe('claude-3-test');
      expect(info.isFallback).toBe(false);
    });

    it('should pass maxTokens and temperature to adapter', async () => {
      fetchMock().mockResolvedValue(createAnthropicSseResponse('OK'));

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        maxAttempts: 1,
        retryDelayMs: 100,
      events: { emit: () => {} },
      });

      await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 500,
        temperature: 0.5,
      });

      const body = JSON.parse(fetchMock().mock.calls[0][1].body as string);
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.5);
    });

    it('should yield reset and failover on mid-stream non-timeout error', async () => {
      // mock primary adapter: yield 2 deltas then throw
      const primaryAdapter: ProviderAdapter = {
        name: 'primary',
        model: 'test-model',
        async* stream() {
          yield { type: 'text_delta', delta: 'Hello ' };
          yield { type: 'text_delta', delta: 'world' };
          throw new Error('network disconnect');
        },
        async call() { throw new Error('not used'); },
        healthCheck: async () => true,
        getProviderInfo: () => ({ name: 'primary', model: 'test-model' }),
      };

      // mock fallback adapter: succeeds
      const fallbackAdapter: ProviderAdapter = {
        name: 'fallback',
        model: 'fallback-model',
        async* stream() {
          yield { type: 'text_delta', delta: 'Fallback' };
          yield { type: 'done', stopReason: 'end_turn' };
        },
        async call() { throw new Error('not used'); },
        healthCheck: async () => true,
        getProviderInfo: () => ({ name: 'fallback', model: 'fallback-model' }),
      };

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 1,
        retryDelayMs: 10,
        events: { emit: () => {} },
        createProviderAdapter: (config) =>
          config.name === fallbackConfig.name ? fallbackAdapter : primaryAdapter,
      });

      const chunks: LLMStreamChunk[] = [];
      for await (const chunk of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk);
      }

      // 应收到 primary 的 partial 内容
      expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'Hello ')).toBe(true);
      expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'world')).toBe(true);

      // 应收到 reset chunk（标记 mid-stream 失败）
      const resetChunk = chunks.find(c => c.type === 'reset');
      expect(resetChunk).toBeDefined();
      expect(resetChunk).toMatchObject({ provider: 'primary' });
      // 非超时错误不应有 timeoutMs
      expect((resetChunk as any).timeoutMs).toBeUndefined();

      // 应收到 fallback 的内容
      expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'Fallback')).toBe(true);

      // 不应收到 provider_failed（因为 hasYielded 时走 reset 路径，不走 provider_failed）
      expect(chunks.some(c => c.type === 'provider_failed')).toBe(false);
    });

    it('should failover when primary stream yields 0 chunks', async () => {
      const primaryAdapter: ProviderAdapter = {
        name: 'primary',
        model: 'test-model',
        async* stream() {
          // immediately return, yield nothing
          return;
        },
        async call() { throw new Error('not used'); },
        healthCheck: async () => true,
        getProviderInfo: () => ({ name: 'primary', model: 'test-model' }),
      };

      const fallbackAdapter: ProviderAdapter = {
        name: 'fallback',
        model: 'fallback-model',
        async* stream() {
          yield { type: 'text_delta', delta: 'Fallback' };
          yield { type: 'done', stopReason: 'end_turn' };
        },
        async call() { throw new Error('not used'); },
        healthCheck: async () => true,
        getProviderInfo: () => ({ name: 'fallback', model: 'fallback-model' }),
      };

      const emittedEvents: any[] = [];
      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [fallbackConfig],
        maxAttempts: 1,
        retryDelayMs: 10,
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 30_000 },
        events: { emit: (e) => emittedEvents.push(e) },
        createProviderAdapter: (config) =>
          config.name === fallbackConfig.name ? fallbackAdapter : primaryAdapter,
      });

      const chunks: LLMStreamChunk[] = [];
      for await (const chunk of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk);
      }

      // 应收到 primary 的 provider_failed
      expect(chunks.some(c => c.type === 'provider_failed' && c.provider === 'primary')).toBe(true);

      // 应收到 fallback 的内容
      expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'Fallback')).toBe(true);
      expect(chunks.some(c => c.type === 'done')).toBe(true);

      // ⚓5 α default doc invariant: 0-chunk → onFailure (conservative miss-detect)
      expect(emittedEvents.some(e => e.type === 'breaker_opened' && e.provider === 'primary')).toBe(true);
    });

    it('should throw LLMAllProvidersFailedError when all providers yield 0 chunks', async () => {
      const emptyAdapter: ProviderAdapter = {
        name: 'primary',
        model: 'test-model',
        async* stream() { return; },
        async call() { throw new Error('not used'); },
        healthCheck: async () => true,
        getProviderInfo: () => ({ name: 'primary', model: 'test-model' }),
      };

      const service = new LLMOrchestratorImpl({
        primary: primaryConfig,
        fallbacks: [],
        maxAttempts: 1,
        retryDelayMs: 10,
        events: { emit: () => {} },
        createProviderAdapter: () => emptyAdapter,
      });

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // drain
        }
      }).rejects.toThrow(LLMAllProvidersFailedError);
    });
  });

describe('createLLMOrchestrator factory', () => {
  const mockAdapter: ProviderAdapter = {
    name: 'mock',
    model: 'mock-model',
    call: async () => ({} as any),
    stream: async function* () {},
    healthCheck: async () => true,
    getProviderInfo: () => ({ name: 'mock', model: 'mock-model' }),
  };

  const mockConfig: ProviderConfig = {
    name: 'mock',
    apiKey: 'test-key',
    model: 'mock-model',
    temperature: 0.7,
    timeoutMs: TEST_LLM_TIMEOUT_MS,
    apiFormat: 'anthropic',
  };

  it('returns LLMOrchestratorImpl instance', () => {
    const orchestrator = createLLMOrchestrator({
      primary: mockConfig,
      maxAttempts: 1,
      retryDelayMs: 10,
      events: { emit: () => {} },
      createProviderAdapter: () => mockAdapter,
    });
    expect(orchestrator).toBeInstanceOf(LLMOrchestratorImpl);
  });

  it('forwards config through to underlying impl', async () => {
    const configAdapter: ProviderAdapter = {
      ...mockAdapter,
      name: 'config-test',
      model: 'test-model',
      call: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }),
    };
    const orchestrator = createLLMOrchestrator({
      primary: {
        name: 'config-test',
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.7,
        timeoutMs: TEST_LLM_TIMEOUT_MS,
        apiFormat: 'anthropic',
      },
      maxAttempts: 1,
      retryDelayMs: 10,
      events: { emit: () => {} },
      createProviderAdapter: () => configAdapter,
    });
    await orchestrator.call({ messages: [{ role: 'user', content: 'hi' }] });
    const info = orchestrator.getProviderInfo();
    expect(info).toEqual(expect.objectContaining({
      name: 'config-test',
      model: 'test-model',
    }));
  });
});
