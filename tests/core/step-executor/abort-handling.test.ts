/**
 * Abort handling tests for step-executor
 * Phase 538 Step A — D.1 + D.2
 */

import { describe, it, expect, vi } from 'vitest';
import { executeStep } from '../../../src/core/step-executor/index.js';
import { IdleTimeoutSignal } from '../../../src/core/signals.js';
import { INIT_LLM_IDLE_TIMEOUT_MS } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../../src/foundation/llm-orchestrator/types.js';
import type { Message, LLMResponse } from '../../../src/foundation/llm-provider/types.js';
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

function makeRegistry(map: Record<string, { readonly: boolean }>): ToolRegistry {
  return {
    get: (name: string) => map[name] ?? { readonly: false },
  } as unknown as ToolRegistry;
}

function makeCtx(opts: { signal?: AbortSignal } = {}): ExecContext {
  return makeExecContext({ signal: opts.signal });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StepExecutor abort handling (Phase 538)', () => {

  it('abort-during-tool-call: signal 不剥除 / executeToolCalls 开头立即 throw / 工具不执行', async () => {
    const abortController = new AbortController();
    abortController.abort({ type: 'idle_timeout', ms: INIT_LLM_IDLE_TIMEOUT_MS });

    const exec = {
      execute: vi.fn(async () => ({ success: true, content: 'done' })),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(),
    } as unknown as IToolExecutor;

    const llm = makeMockLLM([{
      content: [{ type: 'tool_use', id: 'tu1', name: 'slowWrite', input: { path: 'foo' } }],
      stop_reason: 'tool_use',
    }]);

    const ctx = makeCtx({ signal: abortController.signal });

    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({ slowWrite: { readonly: false } }), ctx,
    })).rejects.toThrow(IdleTimeoutSignal);

    // Phase 538 D.1: abort 期不剥 signal / executeToolCalls 内 check ctx.signal?.aborted
    // → 工具不执行（不是旧代码的「剥 signal → 执行工具 → 再兜底 throw」）
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it('abort-stream-with-partial-tool-use: 立即抛 / 不 finalize', async () => {
    const abortController = new AbortController();

    async function* stream(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'testTool', partialInput: '' } };
      yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"path":"foo' } };
      abortController.abort({ type: 'idle_timeout', ms: INIT_LLM_IDLE_TIMEOUT_MS });
      throw new Error('Execution aborted');
    }

    const llm = {
      call: vi.fn(),
      stream: vi.fn(() => stream()),
      healthCheck: vi.fn(async () => true),
      getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
      close: vi.fn(),
    } as unknown as LLMOrchestrator;

    const exec = makeExecutor({});
    const ctx = makeCtx({ signal: abortController.signal });

    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({}), ctx,
    })).rejects.toThrow(IdleTimeoutSignal);

    // finalize 未执行 → 工具不被调用
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it('abort-stream-text-only: 立即抛 IdleTimeoutSignal', async () => {
    const abortController = new AbortController();

    async function* stream(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'text_delta', delta: 'Hello' };
      abortController.abort({ type: 'idle_timeout', ms: INIT_LLM_IDLE_TIMEOUT_MS });
      throw new Error('Execution aborted');
    }

    const llm = {
      call: vi.fn(),
      stream: vi.fn(() => stream()),
      healthCheck: vi.fn(async () => true),
      getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
      close: vi.fn(),
    } as unknown as LLMOrchestrator;

    const ctx = makeCtx({ signal: abortController.signal });

    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx,
    })).rejects.toThrow(IdleTimeoutSignal);
  });

  it('正常 tool_use stream 完整收 / regression 防', async () => {
    const llm = makeMockLLM([{
      content: [{ type: 'tool_use', id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
      stop_reason: 'tool_use',
    }]);

    const exec = makeExecutor({ echo: { success: true, content: 'hi-back' } });
    const messages: Message[] = [];

    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({ echo: { readonly: false } }), ctx: makeCtx(),
    });

    expect(result.kind).toBe('continue');
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(2); // assistant tool_use + user tool_result
  });
});
