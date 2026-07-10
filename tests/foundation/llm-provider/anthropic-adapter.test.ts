import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../../src/foundation/llm-provider/anthropic.js';
import { LLM_PROVIDER_AUDIT_EVENTS } from '../../../src/foundation/llm-provider/audit-events.js';
import { LLMContextExceededError } from '../../../src/foundation/llm-provider/errors.js';
import { BadRequestError } from '@anthropic-ai/sdk';
import { TEST_LLM_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();

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

function createFailingSDKStream(error: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next(): Promise<IteratorResult<unknown>> {
          return Promise.reject(error);
        },
      };
    },
  };
}

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  class BadRequestError extends APIError {}
  class RateLimitError extends Error {
    headers?: Headers;
    constructor(message: string, headers?: Headers) {
      super(message);
      this.headers = headers;
    }
  }
  class APIConnectionTimeoutError extends Error {}
  class APIUserAbortError extends Error {}
  class AuthenticationError extends Error { status = 401; }
  class PermissionDeniedError extends Error { status = 403; }
  class NotFoundError extends Error { status = 404; }
  class MockAnthropic {
    messages = {
      create: mockMessagesCreate,
      stream: mockMessagesStream,
    };
  }
  return {
    default: MockAnthropic,
    APIError,
    BadRequestError,
    RateLimitError,
    APIConnectionTimeoutError,
    APIUserAbortError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
  };
});

const BUDGET_ERROR_MESSAGE =
  "This model's maximum context length is 1048565 tokens. However, you requested " +
  '1052788 tokens (659572 in the messages, 393216 in the completions).';

const ZERO_BUDGET_ERROR_MESSAGE =
  "This model's maximum context length is 1000 tokens. However, you requested " +
  '1100 tokens (1000 in the messages, 100 in the completions).';

function createAuditSink() {
  const writes: unknown[][] = [];
  return {
    writes,
    sink: {
      write: (type: string, ...cols: unknown[]) => writes.push([type, ...cols]),
      preview: (s: string) => s,
    },
  };
}

describe('AnthropicAdapter', () => {
  const config = {
    name: 'anthropic',
    apiKey: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-sonnet',
    maxTokens: 4096,
    temperature: 0.7,
    timeoutMs: TEST_LLM_TIMEOUT_MS,
    apiFormat: 'anthropic' as const,
  };

  beforeEach(() => {
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
  });

  describe('call()', () => {
    it('retries with adjusted max_tokens on BadRequestError (output budget exceeded)', async () => {
      const { writes, sink } = createAuditSink();
      const adapter = new AnthropicAdapter({ ...config, auditLog: sink as any });

      mockMessagesCreate
        .mockRejectedValueOnce(new BadRequestError(400, BUDGET_ERROR_MESSAGE))
        .mockResolvedValueOnce({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 1 },
        });

      const result = await adapter.call({ messages: [], maxTokens: 393216 });

      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
      expect(mockMessagesCreate.mock.calls[1][0]).toMatchObject({
        max_tokens: 1048565 - 659572,
      });

      const audit = writes.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
      expect(audit).toBeDefined();
      expect(audit).toEqual(
        expect.arrayContaining([
          LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED,
          expect.stringContaining('provider=anthropic'),
          expect.stringContaining('model=claude-3-sonnet'),
          expect.stringContaining('original_max_tokens=393216'),
          expect.stringContaining(`adjusted_max_tokens=${1048565 - 659572}`),
          expect.stringContaining('context_limit=1048565'),
          expect.stringContaining('input_tokens=659572'),
        ]),
      );
    });

    it('throws LLMContextExceededError when adjusted budget is not positive', async () => {
      const { writes, sink } = createAuditSink();
      const adapter = new AnthropicAdapter({ ...config, auditLog: sink as any });

      mockMessagesCreate.mockRejectedValueOnce(new BadRequestError(400, ZERO_BUDGET_ERROR_MESSAGE));

      await expect(adapter.call({ messages: [], maxTokens: 100 })).rejects.toBeInstanceOf(
        LLMContextExceededError,
      );

      const audit = writes.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
      expect(audit).toBeDefined();
      expect(audit).toEqual(
        expect.arrayContaining([expect.stringContaining('reason=nonpositive_adjusted')]),
      );
    });
  });

  describe('stream()', () => {
    it('retries with adjusted max_tokens on preflight BadRequestError', async () => {
      const { writes, sink } = createAuditSink();
      const adapter = new AnthropicAdapter({ ...config, auditLog: sink as any });

      mockMessagesStream
        .mockReturnValueOnce(createFailingSDKStream(new BadRequestError(400, BUDGET_ERROR_MESSAGE)))
        .mockReturnValueOnce(
          createMockSDKStream([
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          ]),
        );

      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream({ messages: [], maxTokens: 393216 })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(mockMessagesStream).toHaveBeenCalledTimes(2);
      expect(mockMessagesStream.mock.calls[1][0]).toMatchObject({
        max_tokens: 1048565 - 659572,
      });

      const audit = writes.find(e => e[0] === LLM_PROVIDER_AUDIT_EVENTS.OUTPUT_BUDGET_ADJUSTED);
      expect(audit).toBeDefined();
    });
  });

  describe('thinking budget guard', () => {
    const THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE =
      "This model's maximum context length is 105000 tokens. However, you requested " +
      '105000 tokens (55000 in the messages, 50000 in the completions).';

    it('retries with adaptive thinking mode despite configured thinkingBudgetTokens', async () => {
      const adapter = new AnthropicAdapter({
        ...config,
        thinking: true,
        thinkingMode: 'adaptive',
        thinkingBudgetTokens: 100000,
      });

      mockMessagesCreate
        .mockRejectedValueOnce(new BadRequestError(400, BUDGET_ERROR_MESSAGE))
        .mockResolvedValueOnce({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 1 },
        });

      const result = await adapter.call({ messages: [], maxTokens: 393216 });

      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
      expect(mockMessagesCreate.mock.calls[1][0]).toMatchObject({
        max_tokens: 1048565 - 659572,
        thinking: { type: 'adaptive', effort: 'high' },
      });
    });

    it('throws LLMContextExceededError when effective thinking budget equals adjusted max_tokens (call)', async () => {
      const adapter = new AnthropicAdapter({
        ...config,
        thinking: true,
        thinkingMode: 'enabled',
        thinkingBudgetTokens: 50000,
      });

      mockMessagesCreate.mockRejectedValueOnce(
        new BadRequestError(400, THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE),
      );

      await expect(adapter.call({ messages: [], maxTokens: 60000 })).rejects.toBeInstanceOf(
        LLMContextExceededError,
      );
      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    });

    it('throws LLMContextExceededError when effective thinking budget equals adjusted max_tokens (stream)', async () => {
      const adapter = new AnthropicAdapter({
        ...config,
        thinking: true,
        thinkingMode: 'enabled',
        thinkingBudgetTokens: 50000,
      });

      mockMessagesStream.mockReturnValueOnce(
        createFailingSDKStream(new BadRequestError(400, THINKING_BUDGET_EQUALS_ADJUSTED_MESSAGE)),
      );

      await expect(
        (async () => {
          for await (const _chunk of adapter.stream({ messages: [], maxTokens: 60000 })) {
            // no-op
          }
        })(),
      ).rejects.toBeInstanceOf(LLMContextExceededError);
      expect(mockMessagesStream).toHaveBeenCalledTimes(1);
    });
  });
});
