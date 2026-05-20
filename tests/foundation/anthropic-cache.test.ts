/**
 * AnthropicAdapter cache_control tests
 *
 * Tests for KV cache optimization:
 * 1. system prompt with cache_control
 * 2. tools last item with cache_control
 * 3. formatMessages last user message with cache_control
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ToolDefinition } from '../../src/types/message.js';
import { AnthropicAdapter } from '../../src/foundation/llm-provider/anthropic.js';
import { TEST_LLM_TIMEOUT_MS } from '../helpers/test-timeouts.js';

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
  RateLimitError: class RateLimitError extends Error {},
  APIConnectionTimeoutError: class APIConnectionTimeoutError extends Error {},
  APIUserAbortError: class APIUserAbortError extends Error {},
  AuthenticationError: class AuthenticationError extends Error { status = 401; },
  PermissionDeniedError: class PermissionDeniedError extends Error { status = 403; },
  NotFoundError: class NotFoundError extends Error { status = 404; },
}));

// Helper to create a mock Response
function createMockResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map() as unknown as Headers,
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

describe('AnthropicAdapter cache_control', () => {
  const config = {
    name: 'anthropic',
    apiKey: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-sonnet',
    maxTokens: 4096,
    temperature: 0.7,
    timeoutMs: TEST_LLM_TIMEOUT_MS,
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('system prompt format', () => {
    it('should convert system to array with cache_control when provided', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a helpful assistant.',
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.system).toEqual([
        { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('should not set system when not provided', async () => {
      mockMessagesCreate.mockResolvedValue({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-3-sonnet',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.system).toBeUndefined();
    });
  });

  describe('tools cache_control', () => {
    const tools: ToolDefinition[] = [
      { name: 'read', description: 'Read file', input_schema: { type: 'object' } },
      { name: 'write', description: 'Write file', input_schema: { type: 'object' } },
      { name: 'exec', description: 'Execute command', input_schema: { type: 'object' } },
    ];

    it('should add cache_control to last tool only', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'OK' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: 'Do something' }],
        tools,
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.tools).toHaveLength(3);
      expect(requestBody.tools[0].cache_control).toBeUndefined();
      expect(requestBody.tools[1].cache_control).toBeUndefined();
      expect(requestBody.tools[2].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should add cache_control to single tool', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'OK' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: 'Read file' }],
        tools: [tools[0]],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should not set tools when empty', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'OK' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.tools).toBeUndefined();
    });
  });

  describe('formatMessages cache_control', () => {
    it('should add cache_control to last user message (string content)', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'Hi' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.messages[0].role).toBe('user');
      expect(requestBody.messages[0].content).toEqual([
        { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('should add cache_control to last user message (text-only array)', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'Hi' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      expect(requestBody.messages[0].content).toEqual([
        { type: 'text', text: 'hello world', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('should add cache_control to last block of structured user message (tool_result)', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'OK' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [
          { role: 'user', content: 'Query' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File content' }] },
        ],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      // messages[0] is first user message, not the last
      expect(requestBody.messages[0].content).toBe('Query');
      // messages[2] is last user message with tool_result
      expect(requestBody.messages[2].role).toBe('user');
      expect(requestBody.messages[2].content).toHaveLength(1);
      expect(requestBody.messages[2].content[0]).toMatchObject({
        type: 'tool_result',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('should add cache_control to first user when only user+assistant pair', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'Reply' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
        ],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      // First user message gets cache_control (last user in list)
      expect(requestBody.messages[0].content).toEqual([
        { type: 'text', text: 'Question', cache_control: { type: 'ephemeral' } },
      ]);
      // Assistant message: simplified formatMessages keeps array format for native Anthropic API
      expect(requestBody.messages[1].content).toEqual([{ type: 'text', text: 'Answer' }]);
    });

    it('should only add cache_control to last user message, not middle ones', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'Reply' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Reply 1' },
          { role: 'user', content: 'Second' },
        ],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      // First user message: no cache_control (not last), string preserved
      expect(requestBody.messages[0].content).toBe('First');
      // Assistant: simplified formatMessages keeps array format
      expect(requestBody.messages[1].content).toBe('Reply 1');
      // Last user message: with cache_control
      expect(requestBody.messages[2].content).toEqual([
        { type: 'text', text: 'Second', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('should handle multiple messages with assistant at end', async () => {
      mockMessagesCreate.mockResolvedValue(
        createAnthropicResponse([{ type: 'text', text: 'Final' }])
      );

      const adapter = new AnthropicAdapter(config);
      await adapter.call({
        messages: [
          { role: 'user', content: 'Q1' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
          { role: 'assistant', content: 'A2' },
        ],
      });

      const requestBody = mockMessagesCreate.mock.calls[0][0];
      // First user is not last
      expect(requestBody.messages[0].content).toBe('Q1');
      // Last user is messages[2], gets cache_control
      expect(requestBody.messages[2].content).toEqual([
        { type: 'text', text: 'Q2', cache_control: { type: 'ephemeral' } },
      ]);
      // Assistant messages: simplified formatMessages keeps array format
      expect(requestBody.messages[1].content).toBe('A1');
      expect(requestBody.messages[3].content).toBe('A2');
    });
  });

  describe('stream() cache_control', () => {
    it('should apply same cache_control in stream mode', async () => {
      const streamEvents = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 2 } },
      ];
      mockMessagesStream.mockReturnValue(createMockSDKStream(streamEvents));

      const adapter = new AnthropicAdapter(config);
      const streamIterator = adapter.stream({
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'System prompt',
        tools: [{ name: 'test', description: 'Test tool', input_schema: { type: 'object' } }],
      });

      // Consume stream
      for await (const _ of streamIterator) {
        // Empty
      }

      const requestBody = mockMessagesStream.mock.calls[0][0];
      // System has cache_control
      expect(requestBody.system).toEqual([
        { type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral' } },
      ]);
      // Tool has cache_control
      expect(requestBody.tools[0].cache_control).toEqual({ type: 'ephemeral' });
      // Message has cache_control
      expect(requestBody.messages[0].content).toEqual([
        { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
      ]);
    });
  });
});
