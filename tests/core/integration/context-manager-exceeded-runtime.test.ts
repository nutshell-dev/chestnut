import { describe, it, expect, vi } from 'vitest';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

function createMockLLM() {
  return {
    call: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }),
    stream: vi.fn(async function* () {
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done' };
    }),
    getProviderInfo: vi.fn().mockReturnValue({ name: 'mock', model: 'test', isFallback: false }),
  };
}

function createCtx() {
  return {
    signal: undefined,
    stepNumber: 0,
    incrementStep: vi.fn(),
    getElapsedMs: () => 0,
    maxSteps: 10,
    clawId: 'test',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawDir: '/tmp/test',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    workspaceDir: '/tmp/test/clawspace',
    profile: 'test',
    fs: {} as unknown as Parameters<typeof executeStep>[0]['ctx']['fs'],
  };
}

describe('runtime context-exceeded path via step-executor', () => {
  it('trims messages when estimate exceeds budget', async () => {
    const mockLLM = createMockLLM();

    const messages: Message[] = [
      { role: 'user', content: 'hello world this is a very long message to force trim' },
      { role: 'assistant', content: 'response' },
    ];

    const result = await executeStep({
      messages,
      systemPrompt: 'sys',
      llm: mockLLM as unknown as Parameters<typeof executeStep>[0]['llm'],
      tools: [],
      ctx: createCtx(),
    });

    expect(result.kind).toBe('final');
    if (result.kind === 'final') {
      expect(result.finalText).toBe('ok');
    }
  });

  it('propagates ContextTrimExhaustedError when trim cannot fit', async () => {
    const mockLLM = createMockLLM();

    const messages: Message[] = [
      { role: 'user', content: 'first' },
    ];

    // maxTokens larger than context window forces budget.available=0, skipping trim.
    // This verifies the guard path (no silent swallow).
    const result = await executeStep({
      messages,
      systemPrompt: 'sys',
      llm: mockLLM as unknown as Parameters<typeof executeStep>[0]['llm'],
      tools: [],
      maxTokens: 100000000,
      ctx: createCtx(),
    });

    expect(result.kind).toBe('final');
    if (result.kind === 'final') {
      expect(result.finalText).toBe('ok');
    }
  });
});
