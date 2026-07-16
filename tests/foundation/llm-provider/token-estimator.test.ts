import { describe, it, expect } from 'vitest';
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolTokens,
  estimateToolsTokens,
  estimateInputTokens,
  PER_MESSAGE_OVERHEAD_TOKENS,
} from '../../../src/foundation/llm-provider/token-estimator.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/index.js';

describe('token-estimator', () => {
  describe('estimateTextTokens', () => {
    it('empty string returns 0', () => {
      expect(estimateTextTokens('')).toBe(0);
    });

    it('English text ~ char count / 4 (cl100k_base accuracy)', () => {
      const text = 'Hello world, this is a test sentence.';
      const tokens = estimateTextTokens(text);
      // cl100k_base 精确值约 8-10 tokens for this sentence (English)
      // 4 chars/token heuristic 约 9-10 tokens
      // 允 ±30% 范围 (tokens count 短文本 fluctuate)
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(15);
    });

    it('CJK text encoding (Chinese)', () => {
      const text = '你好，世界，这是一段中文文本测试。';
      const tokens = estimateTextTokens(text);
      // CJK chars 通常 1-2 tokens per char in cl100k_base
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(50);
    });
  });

  describe('estimateMessageTokens', () => {
    it('string content message includes PER_MESSAGE_OVERHEAD_TOKENS', () => {
      const msg: Message = { role: 'user', content: 'hi' };
      const tokens = estimateMessageTokens(msg);
      expect(tokens).toBeGreaterThanOrEqual(PER_MESSAGE_OVERHEAD_TOKENS);
    });

    it('array content with text block', () => {
      const msg: Message = {
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
      };
      const tokens = estimateMessageTokens(msg);
      expect(tokens).toBeGreaterThan(PER_MESSAGE_OVERHEAD_TOKENS);
    });

    it('array content with tool_use block', () => {
      const msg: Message = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will use a tool' },
          {
            type: 'tool_use',
            id: 'tool_123' as never,
            name: 'calculator',
            input: { a: 1, b: 2 },
          },
        ],
      };
      const tokens = estimateMessageTokens(msg);
      expect(tokens).toBeGreaterThan(PER_MESSAGE_OVERHEAD_TOKENS + 5);
    });

    it('array content with tool_result block', () => {
      const msg: Message = {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_123' as never,
            content: 'Result: 3',
          },
        ],
      };
      const tokens = estimateMessageTokens(msg);
      expect(tokens).toBeGreaterThan(PER_MESSAGE_OVERHEAD_TOKENS);
    });

    it('thinking block', () => {
      const msg: Message = {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me consider this carefully.' }],
      };
      const tokens = estimateMessageTokens(msg);
      expect(tokens).toBeGreaterThan(PER_MESSAGE_OVERHEAD_TOKENS);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('empty array returns 0', () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it('multiple messages sum tokens', () => {
      const messages: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ];
      const tokens = estimateMessagesTokens(messages);
      // 2 messages × PER_MESSAGE_OVERHEAD + text
      expect(tokens).toBeGreaterThanOrEqual(2 * PER_MESSAGE_OVERHEAD_TOKENS);
    });
  });

  describe('estimateToolTokens / estimateToolsTokens', () => {
    it('tool definition includes name + description + schema', () => {
      const tool: ToolDefinition = {
        name: 'calculator',
        description: 'Performs basic arithmetic',
        input_schema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      };
      const tokens = estimateToolTokens(tool);
      expect(tokens).toBeGreaterThan(5);
    });

    it('empty tools array returns 0', () => {
      expect(estimateToolsTokens([])).toBe(0);
    });
  });

  describe('estimateInputTokens (composite)', () => {
    it('returns breakdown by source', () => {
      const result = estimateInputTokens({
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            name: 'calc',
            description: 'calculator',
            input_schema: { type: 'object' },
          },
        ],
      });
      expect(result.systemPromptTokens).toBeGreaterThan(0);
      expect(result.messagesTokens).toBeGreaterThanOrEqual(PER_MESSAGE_OVERHEAD_TOKENS);
      expect(result.toolsTokens).toBeGreaterThan(0);
      expect(result.total).toBe(
        result.systemPromptTokens + result.messagesTokens + result.toolsTokens
      );
    });

    it('omits systemPrompt when undefined', () => {
      const result = estimateInputTokens({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.systemPromptTokens).toBe(0);
      expect(result.toolsTokens).toBe(0);
    });

    it('omits tools when undefined', () => {
      const result = estimateInputTokens({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.toolsTokens).toBe(0);
    });
  });

  describe('PER_MESSAGE_OVERHEAD_TOKENS constant', () => {
    it('equals 4 (Anthropic / OpenAI doc boilerplate)', () => {
      expect(PER_MESSAGE_OVERHEAD_TOKENS).toBe(4);
    });
  });
});
