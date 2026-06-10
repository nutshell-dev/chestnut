import { describe, it, expect } from 'vitest';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

describe('runtime/step-executor dialog persist invariant under trim (phase 224)', () => {
  it('trim 触发条件下 step 完成后、caller 持引用应含本步 assistant 内容', async () => {
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
    const messagesRef = messages;

    const mockLLM = {
      stream: async function* () {
        yield { type: 'text_delta' as const, delta: 'ok' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 100, outputTokens: 5 } };
      },
      getProviderInfo: () => ({ model: 'volc-ds4pro', name: 'volc-ds4pro' }),
    };

    await executeStep({
      messages,
      systemPrompt: 'sys',
      llm: mockLLM as any,
      tools: [],
      executor: {} as any,
      registry: {} as any,
      ctx: { stepNumber: 0 as any, signal: undefined, trace_id: undefined } as any,
      callbacks: {},
      maxTokens: 1000,
    });

    // 关键 invariant：caller 持的原 messages 引用应被 push、不被切断
    expect(messagesRef).toBe(messages);
    expect(messagesRef.length).toBeGreaterThanOrEqual(4); // user + assistant(big) + user + new assistant
    expect(messagesRef.at(-1)?.role).toBe('assistant');
  });
});
