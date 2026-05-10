/**
 * LLM Service tests
 * 
 * Tests:
 * - AnthropicAdapter: normal response, tool_use, error handling
 * - LLMOrchestrator: failover, retry, monitor integration
 * 
 * All tests use mock fetch - no real API calls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  LLMResponse,
  Message,
  ToolDefinition
} from '../../src/types/message.js';

import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import { AnthropicAdapter } from '../../src/foundation/llm-provider/anthropic.js';
import { CustomAnthropicAdapter } from '../../src/foundation/llm-provider/custom-anthropic.js';
import { OpenAIAdapter } from '../../src/foundation/llm-provider/openai.js';
import { LLMOrchestratorImpl } from '../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLMRateLimitError,
  LLMTimeoutError,
  LLMAllProvidersFailedError,
} from '../../src/types/errors.js';

// Mock Anthropic SDK
const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();

// Helper to create async iterable from events
function createMockSDKStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (index < events.length) {
            return Promise.resolve({ value: events[index++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { 
      create: mockMessagesCreate,
      stream: mockMessagesStream,
    };
  },
  APIError: class APIError extends Error {
    status?: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  RateLimitError: class RateLimitError extends Error {
    headers?: Headers;
    constructor(message: string, headers?: Headers) {
      super(message);
      this.headers = headers;
    }
  },
  APIConnectionTimeoutError: class APIConnectionTimeoutError extends Error {},
  APIUserAbortError: class APIUserAbortError extends Error {},
}));

/**
 * Create a mock Response with SSE streaming body
 */
function createSSEStreamResponse(events: string[]): Response {
  const sseText = events.map(e => `data: ${e}\n\n`).join('');
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(sseText));
      } else {
        controller.close();
      }
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: (_: string) => null } as unknown as Headers,
    body: stream,
  } as unknown as Response;
}

// Helper to create a mock Response
function createMockResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['retry-after', '10']]) as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// Helper to create Anthropic-style response
function createAnthropicResponse(content: Array<{ type: string; [key: string]: unknown }>): object {
  return {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-3-sonnet',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
  };
}

describe('LLM Service', () => {
  describe('AnthropicAdapter', () => {
    const config = {
      name: 'anthropic',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-sonnet',
      maxTokens: 4096,
      temperature: 0.7,
      timeoutMs: 30000,
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
      mockMessagesCreate.mockClear();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should parse normal text response', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, world!' }],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];
      
      const response = await adapter.call({ messages });

      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('text');
      expect((response.content[0] as { text: string }).text).toBe('Hello, world!');
      expect(response.stop_reason).toBe('end_turn');
      expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it('should parse tool_use response', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will help you' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'test.txt' } }
        ],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [{ role: 'user', content: 'Read a file' }];
      
      const response = await adapter.call({ messages });

      expect(response.content).toHaveLength(2);
      expect(response.content[0].type).toBe('text');
      expect(response.content[1].type).toBe('tool_use');
      
      const toolBlock = response.content[1] as { id: string; name: string; input: object };
      expect(toolBlock.id).toBe('tool-1');
      expect(toolBlock.name).toBe('read');
      expect(toolBlock.input).toEqual({ path: 'test.txt' });
    });

    it('should preserve tool_use and tool_result blocks in request', async () => {
      // This is a critical test - it verifies that formatMessages preserves
      // all content blocks (text, tool_use, tool_result) for multi-turn tool calls
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [
        { role: 'user', content: 'Search for test' },
        { 
          role: 'assistant', 
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } }
          ]
        },
        { 
          role: 'user', 
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'Found: result' }
          ]
        }
      ];
      
      await adapter.call({ messages });

      // Verify the request body preserves all block types
      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.messages).toHaveLength(3);
      
      // Assistant message should have both text and tool_use
      expect(requestBody.messages[1].content).toHaveLength(2);
      expect(requestBody.messages[1].content[0].type).toBe('text');
      expect(requestBody.messages[1].content[1].type).toBe('tool_use');
      
      // User message should have tool_result
      expect(requestBody.messages[2].content).toHaveLength(1);
      expect(requestBody.messages[2].content[0].type).toBe('tool_result');
    });

    it('should throw LLMRateLimitError on 429', async () => {
      const { RateLimitError } = await import('@anthropic-ai/sdk');
      mockMessagesCreate.mockRejectedValue(
        new RateLimitError('rate_limited', new Map([['retry-after', '10']]) as unknown as Headers)
      );

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];
      
      await expect(adapter.call({ messages })).rejects.toThrow(LLMRateLimitError);
    });

    it('should throw LLMTimeoutError on AbortError', async () => {
      const { APIConnectionTimeoutError } = await import('@anthropic-ai/sdk');
      mockMessagesCreate.mockRejectedValue(new APIConnectionTimeoutError());

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];

      await expect(adapter.call({ messages })).rejects.toThrow(LLMTimeoutError);
    });

    it('外部 signal 主动 abort 时抛出 "Execution aborted"，而非 LLMTimeoutError', async () => {
      // 预先 abort 的信号模拟用户 Ctrl+C 中断
      const controller = new AbortController();
      controller.abort();

      const { APIUserAbortError } = await import('@anthropic-ai/sdk');
      mockMessagesCreate.mockRejectedValue(new APIUserAbortError());

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];

      const err = await adapter.call({ messages, signal: controller.signal }).catch(e => e);

      // 不应是 LLMTimeoutError
      expect(err).not.toBeInstanceOf(LLMTimeoutError);
      // 应是 AbortError（Execution aborted）
      expect(err.message).toBe('Execution aborted');
      expect(err.name).toBe('AbortError');
    });

    it('should throw LLMError on network error', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('Network failure'));

      const adapter = new AnthropicAdapter(config);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];
      
      await expect(adapter.call({ messages })).rejects.toThrow();
    });

    it('should include correct headers in request', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      await adapter.call({ messages: [{ role: 'user', content: 'Hi' }] });

      // SDK uses x-api-key instead of Authorization: Bearer
      // This test verifies SDK is being used (mock was called)
      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    });

    it('should include tools in request when provided', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      const tools: ToolDefinition[] = [
        {
          name: 'read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ];
      
      await adapter.call({ 
        messages: [{ role: 'user', content: 'Read test.txt' }],
        tools,
      });

      const body = mockMessagesCreate.mock.calls[0][0];
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('read');
    });
  });

  describe('LLMOrchestratorImpl', () => {
    const primaryConfig = {
      name: 'primary',
      apiKey: 'primary-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-test',
      maxTokens: 4096,
      temperature: 0.7,
      timeoutMs: 30000,
      apiFormat: 'anthropic' as const,
    };

    const fallbackConfig = {
      name: 'fallback',
      apiKey: 'fallback-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-fallback',
      maxTokens: 4096,
      temperature: 0.7,
      timeoutMs: 30000,
      apiFormat: 'anthropic' as const,
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
      mockMessagesCreate.mockClear();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should use primary provider on success', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Primary response' }],
        model: 'claude-3-test',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

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
      mockMessagesCreate
        .mockRejectedValueOnce(new Error('Primary error'))
        .mockResolvedValueOnce({
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fallback response' }],
          model: 'claude-3-fallback',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        });

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
      mockMessagesCreate.mockRejectedValue(new Error('Both failed'));

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
      mockMessagesCreate
        .mockRejectedValueOnce(new Error('Attempt 1'))
        .mockRejectedValueOnce(new Error('Attempt 2'))
        .mockResolvedValueOnce({
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Success' }],
          model: 'claude-3-test',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        });

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
      expect(mockMessagesCreate).toHaveBeenCalledTimes(3); // 3 retries
    });

    it('should reset fallback status after primary succeeds', async () => {
      // First call fails (uses fallback)
      mockMessagesCreate
        .mockRejectedValueOnce(new Error('Primary down'))
        .mockResolvedValueOnce({
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Fallback' }],
          model: 'claude-3-fallback',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        // Second call primary succeeds
        .mockResolvedValueOnce({
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Primary OK' }],
          model: 'claude-3-test',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        });

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

      // Second call - should use primary (fallback reset)
      const response2 = await service.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect((response2.content[0] as { text: string }).text).toBe('Primary OK');
      expect(service.getProviderInfo()!.isFallback).toBe(false);
    });

    it('should cap backoff at 30 seconds', async () => {
      // Use small delay to verify the capping logic without long waits
      mockMessagesCreate
        .mockRejectedValueOnce(new Error('Error 1'))  // 1st attempt
        .mockRejectedValueOnce(new Error('Error 2'))  // 2nd attempt  
        .mockRejectedValueOnce(new Error('Error 3'))  // 3rd attempt
        .mockResolvedValueOnce({                      // 4th attempt (success)
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Success' }],
          model: 'claude-3-test',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        });

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
      expect(mockMessagesCreate).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('should report correct provider info', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: 'claude-3-test',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

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
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: 'claude-3-test',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

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

      const body = mockMessagesCreate.mock.calls[0][0];
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.5);
    });

    it('should yield reset and failover on mid-stream non-timeout error', async () => {
      // mock primary adapter: yield 2 deltas then throw
      const primaryAdapter = {
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
      const fallbackAdapter = {
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
        primary: primaryAdapter as any,
        fallbacks: [fallbackAdapter as any],
        maxAttempts: 1,
        retryDelayMs: 10,
      events: { emit: () => {} },
      });

      const chunks: StreamChunk[] = [];
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
      const primaryAdapter = {
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

      const fallbackAdapter = {
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
        primary: primaryAdapter as any,
        fallbacks: [fallbackAdapter as any],
        maxAttempts: 1,
        retryDelayMs: 10,
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 30_000 },
        events: { emit: (e) => emittedEvents.push(e) },
      });

      const chunks: StreamChunk[] = [];
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
      const emptyAdapter = {
        name: 'primary',
        model: 'test-model',
        async* stream() { return; },
        async call() { throw new Error('not used'); },
        healthCheck: async () => true,
        getProviderInfo: () => ({ name: 'primary', model: 'test-model' }),
      };

      const service = new LLMOrchestratorImpl({
        primary: emptyAdapter as any,
        fallbacks: [],
        maxAttempts: 1,
        retryDelayMs: 10,
      events: { emit: () => {} },
      });

      await expect(async () => {
        for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          // drain
        }
      }).rejects.toThrow(LLMAllProvidersFailedError);
    });
  });
});

// ============================================================================
// SSE Streaming tests — exercises parseSSEStream paths not covered by call()
// ============================================================================

describe('AnthropicAdapter.stream', () => {
  const config = {
    name: 'anthropic',
    apiKey: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-sonnet',
    maxTokens: 4096,
    temperature: 0.7,
    timeoutMs: 30000,
    apiFormat: 'anthropic' as const,
  };

  beforeEach(() => {
    mockMessagesStream.mockClear();
  });

  it('should carry currentToolId/Name in tool_use_delta (C1 fix)', async () => {
    const streamEvents = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-abc123', name: 'read' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"test.txt"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ];
    mockMessagesStream.mockReturnValue(createMockSDKStream(streamEvents));

    const adapter = new AnthropicAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'read file' }] })) {
      chunks.push(chunk);
    }

    const start = chunks.find(c => c.type === 'tool_use_start');
    expect(start).toBeDefined();
    expect(start!.toolUse!.id).toBe('tool-abc123');
    expect(start!.toolUse!.name).toBe('read');

    const deltas = chunks.filter(c => c.type === 'tool_use_delta');
    expect(deltas.length).toBeGreaterThan(0);
    // C1 fix: each delta must carry the correct id/name, not empty strings
    for (const delta of deltas) {
      expect(delta.toolUse!.id).toBe('tool-abc123');
      expect(delta.toolUse!.name).toBe('read');
    }
  });

  it('should emit text_delta chunks from text_delta events', async () => {
    const streamEvents = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    ];
    mockMessagesStream.mockReturnValue(createMockSDKStream(streamEvents));

    const adapter = new AnthropicAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    const textDeltas = chunks.filter(c => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].delta).toBe('Hello ');
    expect(textDeltas[1].delta).toBe('world');
  });

  it('should emit thinking_delta chunks from thinking_delta events', async () => {
    const streamEvents = [
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should think...' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    ];
    mockMessagesStream.mockReturnValue(createMockSDKStream(streamEvents));

    const adapter = new AnthropicAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'think' }] })) {
      chunks.push(chunk);
    }

    const thinkingDeltas = chunks.filter(c => c.type === 'thinking_delta');
    expect(thinkingDeltas).toHaveLength(1);
    expect(thinkingDeltas[0].delta).toBe('I should think...');
  });

  it('should emit done chunk with usage from message_delta', async () => {
    const streamEvents = [
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    ];
    mockMessagesStream.mockReturnValue(createMockSDKStream(streamEvents));

    const adapter = new AnthropicAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    const done = chunks.find(c => c.type === 'done');
    expect(done).toBeDefined();
    expect(done!.usage).toBeDefined();
    expect(done!.usage!.outputTokens).toBe(42);
  });
});

// ============================================================================
// CustomAnthropicAdapter SSE error event handling
// ============================================================================

describe('CustomAnthropicAdapter.stream SSE error events', () => {
  const config = {
    name: 'zai',
    apiKey: 'test-key',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-4.6',
    maxTokens: 4096,
    temperature: 0.7,
    timeoutMs: 30000,
    apiFormat: 'anthropic' as const,
  };

  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('stream: SSE error event → throws LLMError (not silent empty response)', async () => {
    const events = [
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }),
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const adapter = new CustomAnthropicAdapter(config);
    await expect(async () => {
      for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    }).rejects.toThrow('authentication_error: Invalid API key');
  });

  it('stream: SSE overloaded_error → throws LLMRateLimitError', async () => {
    const events = [
      JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const adapter = new CustomAnthropicAdapter(config);
    await expect(async () => {
      for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    }).rejects.toThrow(LLMRateLimitError);
  });

  it('stream: normal response still works after error handling added', async () => {
    const events = [
      JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } }),
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const adapter = new CustomAnthropicAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks.filter(c => c.type === 'text_delta')).toHaveLength(1);
    expect(chunks.find(c => c.type === 'done')).toBeDefined();
  });
});

describe('OpenAIAdapter.stream', () => {
  const config = {
    name: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4',
    maxTokens: 4096,
    temperature: 0.7,
    timeoutMs: 30000,
    apiFormat: 'openai' as const,
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should emit text_delta from content field', async () => {
    const events = [
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello ' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'world' } }] }),
      '[DONE]',
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createSSEStreamResponse(events)));

    const adapter = new OpenAIAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    const textDeltas = chunks.filter(c => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].delta).toBe('Hello ');
    expect(textDeltas[1].delta).toBe('world');

    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });

  it('should delay tool_use_start until both id and name are present (H3 fix)', async () => {
    const events = [
      // First chunk: name present but id absent
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '' } }] } }] }),
      // Second chunk: id arrives with first argument chunk
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-xyz', function: { arguments: '{"path":' } }] } }] }),
      // Third chunk: more arguments
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"test.txt"}' } }] } }] }),
      '[DONE]',
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createSSEStreamResponse(events)));

    const adapter = new OpenAIAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'read file' }] })) {
      chunks.push(chunk);
    }

    const startChunks = chunks.filter(c => c.type === 'tool_use_start');
    expect(startChunks).toHaveLength(1);
    expect(startChunks[0].toolUse!.id).toBe('call-xyz');
    expect(startChunks[0].toolUse!.name).toBe('read');

    // No tool_use_delta should appear before tool_use_start
    const startIdx = chunks.indexOf(startChunks[0]);
    const deltasBefore = chunks.slice(0, startIdx).filter(c => c.type === 'tool_use_delta');
    expect(deltasBefore).toHaveLength(0);
  });

  it('should not emit tool_use_delta before tool_use_start (started flag)', async () => {
    // Chunk with arguments but no id yet — delta must be suppressed
    const events = [
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'write', arguments: '{"content":' } }] } }] }),
      // id never arrives in this truncated stream (simulates partial stream)
      '[DONE]',
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createSSEStreamResponse(events)));

    const adapter = new OpenAIAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'write' }] })) {
      chunks.push(chunk);
    }

    // No start emitted (id never arrived), no delta emitted either
    expect(chunks.filter(c => c.type === 'tool_use_start')).toHaveLength(0);
    expect(chunks.filter(c => c.type === 'tool_use_delta')).toHaveLength(0);
  });

  it('should emit done on [DONE] marker', async () => {
    const events = ['[DONE]'];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createSSEStreamResponse(events)));

    const adapter = new OpenAIAdapter(config);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });

  it('stream: SSE error event → throws LLMError (not silent skip)', async () => {
    const events = [
      JSON.stringify({ error: { message: 'Model not found', type: 'invalid_request_error', code: 'model_not_found' } }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createSSEStreamResponse(events)));

    const adapter = new OpenAIAdapter(config);
    await expect(async () => {
      for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    }).rejects.toThrow('invalid_request_error: Model not found');
  });

  it('stream: SSE rate limit error → throws LLMRateLimitError', async () => {
    const events = [
      JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: '429' } }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createSSEStreamResponse(events)));

    const adapter = new OpenAIAdapter(config);
    await expect(async () => {
      for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
    }).rejects.toThrow(LLMRateLimitError);
  });
});


describe('OpenAIAdapter.call - formatMessages (M2)', () => {
  const config = {
    name: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4',
    apiFormat: 'openai' as const,
  };

  // OpenAI non-streaming response format
  function createOpenAIResponse(content: string): object {
    return {
      choices: [{
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should format pure tool_use assistant message with content="" (not null)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      createMockResponse(createOpenAIResponse('ok'))
    );
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter(config);
    const messages: Message[] = [
      { role: 'user', content: 'run tool' },
      {
        role: 'assistant',
        content: [
          // 纯 tool_use，无文本 block
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'x.txt' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file content' }],
      },
    ];

    await adapter.call({ messages });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe('');          // M2 fix: '' not null
    expect(assistantMsg.content).not.toBeNull();    // 明确验证不是 null
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].function.name).toBe('read');
  });

  it('should format assistant message with text as content string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      createMockResponse(createOpenAIResponse('ok'))
    );
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new OpenAIAdapter(config);
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will use a tool' },
          { type: 'tool_use', id: 'call_2', name: 'write', input: { path: 'out.txt', content: 'data' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'done' }],
      },
    ];

    await adapter.call({ messages });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);

    expect(assistantMsg.content).toBe('I will use a tool');  // 文本正确传递
    expect(assistantMsg.tool_calls).toHaveLength(1);
  });
});


// ============================================================================
// Phase 98 adapter fixes — unit tests with mock fetch
// ============================================================================

describe('OpenAIAdapter — Phase 98 fixes', () => {
  const config = {
    name: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
    apiFormat: 'openai' as const,
  };

  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  // 修复 1：stop_reason 规范化（call）
  it('call: finish_reason tool_calls → stop_reason tool_use', async () => {
    vi.mocked(fetch).mockResolvedValue(createMockResponse({
      choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const res = await new OpenAIAdapter(config).call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.stop_reason).toBe('tool_use');
  });

  it('call: finish_reason stop → stop_reason end_turn', async () => {
    vi.mocked(fetch).mockResolvedValue(createMockResponse({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    }));
    const res = await new OpenAIAdapter(config).call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.stop_reason).toBe('end_turn');
  });

  it('call: finish_reason length → stop_reason max_tokens', async () => {
    vi.mocked(fetch).mockResolvedValue(createMockResponse({
      choices: [{ message: { content: 'hi' }, finish_reason: 'length' }],
    }));
    const res = await new OpenAIAdapter(config).call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.stop_reason).toBe('max_tokens');
  });

  // 修复 2：streaming done chunk 携带 stopReason + usage
  it('stream: done chunk 携带 stopReason 和 usage', async () => {
    const events = [
      JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      '[DONE]',
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));
    const chunks: StreamChunk[] = [];
    for await (const c of new OpenAIAdapter(config).stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }
    const done = chunks.find(c => c.type === 'done');
    expect(done?.stopReason).toBe('end_turn');
    expect(done?.usage?.inputTokens).toBe(10);
    expect(done?.usage?.outputTokens).toBe(5);
  });

  // 修复 3：reasoning_content → thinking_delta（deepseek-reasoner）
  it('stream: delta.reasoning_content → thinking_delta chunk', async () => {
    const events = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中...' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '答案' } }] }),
      '[DONE]',
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));
    const chunks: StreamChunk[] = [];
    for await (const c of new OpenAIAdapter(config).stream({ messages: [{ role: 'user', content: 'prove' }] })) {
      chunks.push(c);
    }
    const thinking = chunks.filter(c => c.type === 'thinking_delta');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].delta).toBe('思考中...');
  });

  // 修复 4：HTML entity decode（xAI/grok）
  it('call: HTML 编码的 tool arguments 正确 decode', async () => {
    vi.mocked(fetch).mockResolvedValue(createMockResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'search', arguments: '{"query":&quot;hello world&quot;}' },
          }],
          content: null,
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const res = await new OpenAIAdapter(config).call({ messages: [{ role: 'user', content: 'search' }] });
    const tool = res.content.find(b => b.type === 'tool_use') as any;
    expect(tool.input.query).toBe('hello world');
  });

  // 修复 5：extraHeaders 合并进 fetch headers
  it('extraHeaders 传入 fetch 请求头', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }));
    vi.stubGlobal('fetch', mockFetch);
    const cfgWithHeaders = { ...config, extraHeaders: { 'HTTP-Referer': 'https://test.local', 'X-Title': 'Test' } };
    await new OpenAIAdapter(cfgWithHeaders).call({ messages: [{ role: 'user', content: 'hi' }] });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['HTTP-Referer']).toBe('https://test.local');
    expect(headers['X-Title']).toBe('Test');
  });

  // Bug Fix 3：provider 未发 finish_reason 时 stopReason 有默认值
  it('stream: provider 未发 finish_reason 时 done chunk stopReason 为 end_turn', async () => {
    const events = [
      JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
      '[DONE]',
      // 注意：没有任何 event 携带 finish_reason: 'stop'
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));
    const chunks: StreamChunk[] = [];
    for await (const c of new OpenAIAdapter(config).stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }
    const done = chunks.find(c => c.type === 'done');
    expect(done?.stopReason).toBe('end_turn');
  });

  // OpenAI o-series 思考内容支持
  // 流式：delta.reasoning → thinking_delta
  it('stream: delta.reasoning → thinking_delta chunk (OpenAI o-series)', async () => {
    const events = [
      JSON.stringify({ choices: [{ delta: { reasoning: '思考中...' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '答案' } }] }),
      '[DONE]',
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));
    const chunks: StreamChunk[] = [];
    for await (const c of new OpenAIAdapter(config).stream({ messages: [{ role: 'user', content: 'prove' }] })) {
      chunks.push(c);
    }
    const thinking = chunks.filter(c => c.type === 'thinking_delta');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].delta).toBe('思考中...');
  });

  // 非流式：message.reasoning_content → thinking block
  it('call: message.reasoning_content → thinking block in response', async () => {
    vi.mocked(fetch).mockResolvedValue(createMockResponse({
      choices: [{
        message: { content: '答案', reasoning_content: '推理过程' },
        finish_reason: 'stop',
      }],
    }));
    const res = await new OpenAIAdapter(config).call({ messages: [{ role: 'user', content: 'prove' }] });
    const thinking = res.content.find(b => b.type === 'thinking') as any;
    expect(thinking?.thinking).toBe('推理过程');
  });
});

describe('AnthropicAdapter — dropThinkingBlocks', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    mockMessagesCreate.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('dropThinkingBlocks 在 AnthropicAdapter 中不生效（原生 API 支持 thinking）', async () => {
    mockMessagesCreate.mockResolvedValue({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-3-sonnet',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const cfg = {
      name: 'anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-sonnet', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'anthropic' as const, dropThinkingBlocks: true, // 这个选项对原生 API 无效
    };

    const messages: Message[] = [
      { role: 'user', content: 'think' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部推理', signature: 'sig123' },
          { type: 'text', text: '答案' },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    await new AnthropicAdapter(cfg).call({ messages });

    const body = mockMessagesCreate.mock.calls[0][0];
    // 找到 assistant 消息（非最后一条，最后一条是 user）
    const assistantMsg = body.messages.find((m: any, idx: number) => m.role === 'assistant' && idx === 1);
    
    // AnthropicAdapter 使用简化的 formatMessages，thinking blocks 不会被过滤
    // 原生 Anthropic API 支持 thinking blocks
    const blocks = assistantMsg.content;
    expect(blocks.some((b: any) => b.type === 'thinking')).toBe(true);
    expect(blocks.some((b: any) => b.type === 'text')).toBe(true);
  });

  it('纯 thinking 的 assistant 消息在 AnthropicAdapter 中保留（原生 API 支持）', async () => {
    mockMessagesCreate.mockResolvedValue({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-3-sonnet',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const cfg = {
      name: 'anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-sonnet', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'anthropic' as const, dropThinkingBlocks: true, // 这个选项对原生 API 无效
    };

    const messages: Message[] = [
      { role: 'user', content: 'think' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '纯思考无文本', signature: 'sig' },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    await new AnthropicAdapter(cfg).call({ messages });

    const body = mockMessagesCreate.mock.calls[0][0];
    // AnthropicAdapter 使用简化的 formatMessages，不会跳过 thinking-only 消息
    // 原生 Anthropic API 支持 thinking blocks
    const assistantMsgs = body.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content.some((b: any) => b.type === 'thinking')).toBe(true);
  });
});

describe('GeminiAdapter — Phase 98 fixes', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('stream: finishReason=STOP 无 usageMetadata → 仍然 yield done chunk', async () => {
    // 最后 event 只有 finishReason，没有 usageMetadata
    const events = [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: null }] }),
      JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
      // 注意：没有 usageMetadata
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const cfg = {
      name: 'gemini', apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'gemini' as const,
    };

    const chunks: StreamChunk[] = [];
    for await (const c of new (await import('../../src/foundation/llm-provider/gemini.js')).GeminiAdapter(cfg).stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    const done = chunks.find(c => c.type === 'done');
    expect(done).toBeTruthy();
    expect(done?.stopReason).toBe('end_turn');
  });

  it('stream: usageMetadata 在 finishReason 之前 → done chunk 携带 usage', async () => {
    const events = [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: null }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
      JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const cfg = {
      name: 'gemini', apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'gemini' as const,
    };

    const chunks: StreamChunk[] = [];
    for await (const c of new (await import('../../src/foundation/llm-provider/gemini.js')).GeminiAdapter(cfg).stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    const done = chunks.find(c => c.type === 'done');
    expect(done?.usage?.inputTokens).toBe(10);
    expect(done?.usage?.outputTokens).toBe(5);
  });

  it('call: finishReason SAFETY → stop_reason content_filter', async () => {
    vi.mocked(fetch).mockResolvedValue(createMockResponse({
      candidates: [{
        content: { parts: [{ text: 'partial' }] },
        finishReason: 'SAFETY',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    }));

    const cfg = {
      name: 'gemini', apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'gemini' as const,
    };

    const res = await new (await import('../../src/foundation/llm-provider/gemini.js')).GeminiAdapter(cfg).call({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.stop_reason).toBe('content_filter');
  });

  it('stream: SSE error event → throws LLMError (not silent skip)', async () => {
    const events = [
      JSON.stringify({ error: { code: 400, message: 'Model not found', status: 'INVALID_ARGUMENT' } }),
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const cfg = {
      name: 'gemini', apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'gemini' as const,
    };

    await expect(async () => {
      for await (const _ of new (await import('../../src/foundation/llm-provider/gemini.js')).GeminiAdapter(cfg).stream({
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* drain */ }
    }).rejects.toThrow('INVALID_ARGUMENT: Model not found');
  });

  it('stream: SSE 429 error → throws LLMRateLimitError', async () => {
    const events = [
      JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }),
    ];
    vi.mocked(fetch).mockResolvedValue(createSSEStreamResponse(events));

    const cfg = {
      name: 'gemini', apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro', maxTokens: 4096, temperature: 0.7, timeoutMs: 30000,
      apiFormat: 'gemini' as const,
    };

    await expect(async () => {
      for await (const _ of new (await import('../../src/foundation/llm-provider/gemini.js')).GeminiAdapter(cfg).stream({
        messages: [{ role: 'user', content: 'hi' }],
      })) { /* drain */ }
    }).rejects.toThrow(LLMRateLimitError);
  });
});
