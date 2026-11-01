import { describe, expect, it, vi } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/loop.js';
import type { LLMOrchestrator, LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

describe('Phase 2032 recoveryFacts across AgentExecutor invocations', () => {
  it('forwards the same facts to both the tool step and the final LLM step', async () => {
    async function* toolStream(): AsyncIterableIterator<LLMStreamChunk> {
      yield { type: 'tool_use_start', toolUse: { id: 'toolu_1', name: 'echo', partialInput: '' } };
      yield { type: 'tool_use_delta', toolUse: { id: 'toolu_1', name: 'echo', partialInput: '{}' } };
      yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
    }
    async function* finalStream(): AsyncIterableIterator<LLMStreamChunk> {
      yield { type: 'text_delta', delta: 'done' };
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const streams = [toolStream, finalStream];
    let invocation = 0;
    const llm = {
      call: vi.fn(),
      stream: vi.fn(() => streams[invocation++]!()),
      healthCheck: vi.fn(async () => true),
      getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock', isFallback: false })),
      close: vi.fn(),
    } as unknown as LLMOrchestrator;
    const executor = {
      execute: vi.fn(async () => ({ success: true, content: 'ok' })),
      validateArgs: vi.fn(() => ({ valid: true })),
    } as unknown as IToolExecutor;
    const recoveryFacts = {
      interventionIds: ['message-1'],
      configurationRevision: 'config-2',
      startupId: 'boot-3',
    } as const;

    const result = await runReact({
      messages: [{ role: 'user', content: 'work' }],
      systemPrompt: 'sys',
      llm,
      executor,
      ctx: makeExecContext(),
      recoveryFacts,
    });

    expect(result.finalText).toBe('done');
    expect(llm.stream).toHaveBeenCalledTimes(2);
    expect(llm.stream).toHaveBeenNthCalledWith(1, expect.objectContaining({ recoveryFacts }));
    expect(llm.stream).toHaveBeenNthCalledWith(2, expect.objectContaining({ recoveryFacts }));
  });
});
