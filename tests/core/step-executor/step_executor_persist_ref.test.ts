import { describe, it, expect } from 'vitest';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

describe('step-executor messages persist ref (phase 224)', () => {
  it('budget 未超时、messages 引用不变 + push 落原引用', async () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const mockLLM = {
      stream: async function* () {
        yield { type: 'text_delta' as const, delta: 'hi' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
      getProviderInfo: () => ({ model: 'volc-ds4pro', name: 'volc-ds4pro' }),
    };
    await executeStep({
      messages, systemPrompt: 's', llm: mockLLM as any, tools: [],
      executor: {} as any, registry: {} as any,
      ctx: { stepNumber: 0 as any } as any, callbacks: {}, maxTokens: 100,
    });
    expect(messages.length).toBe(2);
    expect(messages.at(-1)?.role).toBe('assistant');
  });

  it('budget 超时（trim 触发）、push 仍落 caller 原引用', async () => {
    // 构造多条 messages：中间一条超大 assistant 可被 trim、首尾 user 受保护
    const bigAssistant: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world '.repeat(65000) }],
    };
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      bigAssistant,
      { role: 'user', content: 'bye' },
    ];
    const mockLLM = {
      stream: async function* () {
        yield { type: 'text_delta' as const, delta: 'short' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
      getProviderInfo: () => ({ model: 'volc-ds4pro', name: 'volc-ds4pro' }),
    };
    await executeStep({
      messages, systemPrompt: 's', llm: mockLLM as any, tools: [],
      executor: {} as any, registry: {} as any,
      ctx: { stepNumber: 0 as any } as any, callbacks: {}, maxTokens: 100,
    });
    // 关键 invariant：caller 持有的 messages 数组应被 push、不被切断
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(messages.at(-1)?.role).toBe('assistant');
  });
});
