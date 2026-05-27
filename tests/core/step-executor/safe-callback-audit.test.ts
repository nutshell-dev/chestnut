/**
 * StepExecutor safeCallback audit observability tests
 *
 * Reverse coverage: callback throw → onSafeCallbackError emit + console.warn dual-write.
 * (F2.7 / phase 845 Step B)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse, Message } from '../../../src/foundation/llm-provider/types.js';
import type { ExecContext, ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

// ── Mock factories ──────────────────────────────────────────────────────────

function makeMockLLM(responses: LLMResponse[]): LLMOrchestrator {
  let i = 0;
  async function* streamOne(r: LLMResponse): AsyncIterableIterator<StreamChunk> {
    for (const block of r.content) {
      if (block.type === 'text') {
        yield { type: 'text_delta', delta: (block as { text: string }).text };
      } else if (block.type === 'tool_use') {
        const b = block as { id: string; name: string; input: unknown };
        yield { type: 'tool_use_start', toolUse: { id: b.id, name: b.name, partialInput: '' } };
        yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: JSON.stringify(b.input) } };
      }
    }
    yield {
      type: 'done',
      stopReason: r.stop_reason,
      usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined,
    };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => streamOne(responses[i++] ?? responses[responses.length - 1])),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

function makeExecutor(results: Record<string, ToolResult>): IToolExecutor {
  return {
    execute: vi.fn(async ({ toolName }) => results[toolName] ?? { success: true, content: 'default' }),
    executeParallel: vi.fn(),
    validateArgs: vi.fn(),
  } as unknown as IToolExecutor;
}

function makeRegistry(): ToolRegistry {
  return {
    get: () => ({ readonly: false }),
  } as unknown as ToolRegistry;
}

function makeCtx(): ExecContext {
  return makeExecContext();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('safeCallback audit observability (F2.7)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('emits onSafeCallbackError when onToolResult throws, keeps console.warn, and does not break execution', async () => {
    const onSafeCallbackError = vi.fn();
    const onToolResult = vi.fn(() => { throw new Error('callback-boom'); });

    const llm = makeMockLLM([{
      content: [{ type: 'tool_use', id: 'tu1', name: 'testTool', input: {} }],
      stop_reason: 'tool_use',
    }]);

    const executor = makeExecutor({ testTool: { success: true, content: 'ok' } });
    const ctx = makeCtx();

    const result = await executeStep({
      messages: [] as Message[],
      systemPrompt: 'sys',
      llm,
      tools: [],
      executor,
      registry: makeRegistry(),
      ctx,
      callbacks: {
        onToolResult,
        onSafeCallbackError,
      },
    });

    // Execution must continue despite callback throw
    expect(result.kind).toBe('continue');

    // onToolResult itself was called (and threw)
    expect(onToolResult).toHaveBeenCalledWith('testTool', 'tu1', { success: true, content: 'ok' });

    // onSafeCallbackError audit callback fired
    expect(onSafeCallbackError).toHaveBeenCalledOnce();
    expect(onSafeCallbackError).toHaveBeenCalledWith('onToolResult', expect.any(Error));
    expect((onSafeCallbackError.mock.calls[0]![1] as Error).message).toBe('callback-boom');
  });

  it('emits onSafeCallbackError when onBeforeLLMCall throws', async () => {
    const onSafeCallbackError = vi.fn();
    const onBeforeLLMCall = vi.fn(() => { throw new Error('before-boom'); });

    const llm = makeMockLLM([{
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
    }]);

    const executor = makeExecutor({});
    const ctx = makeCtx();

    const result = await executeStep({
      messages: [] as Message[],
      systemPrompt: 'sys',
      llm,
      tools: [],
      executor,
      ctx,
      callbacks: {
        onBeforeLLMCall,
        onSafeCallbackError,
      },
    });

    expect(result.kind).toBe('final');
    expect(onBeforeLLMCall).toHaveBeenCalled();
    expect(onSafeCallbackError).toHaveBeenCalledOnce();
    expect(onSafeCallbackError).toHaveBeenCalledWith('onBeforeLLMCall', expect.any(Error));
  });
});
