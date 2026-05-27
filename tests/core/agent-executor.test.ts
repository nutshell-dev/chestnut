/**
 * AgentExecutor loop + persistence + circuit breaker tests
 *
 * Tests runReact as agent-executor module public API (phase 522 ν / black-box mode align production caller).
 */

import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../src/core/agent-executor/index.js';
import { MaxStepsExceededError, ConsecutiveParseErrorsExceededError, ConsecutiveMaxTokensToolUseError } from '../../src/core/agent-executor/errors.js';
import { MAX_CONSECUTIVE_PARSE_ERRORS, MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE } from '../../src/core/agent-executor/constants.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse, Message } from '../../src/foundation/llm-provider/types.js';
import type { ExecContext, ToolResult } from '../../src/foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../src/foundation/tools/executor.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { makeExecContext } from '../helpers/exec-context.js';

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

function makeCtx(): ExecContext {
  return makeExecContext();
}

/** LLM that yields malformed JSON for every tool_use in a sequence of responses */
function makeMalformedSequenceLLM(responses: LLMResponse[]): LLMOrchestrator {
  let i = 0;
  async function* streamOne(r: LLMResponse): AsyncIterableIterator<StreamChunk> {
    for (const block of r.content) {
      if (block.type === 'text') {
        yield { type: 'text_delta', delta: (block as { text: string }).text };
      } else if (block.type === 'tool_use') {
        const b = block as { id: string; name: string; input: unknown };
        yield { type: 'tool_use_start', toolUse: { id: b.id, name: b.name, partialInput: '' } };
        // Deliberately malformed JSON to trigger __parseError path
        yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{invalid json' } };
      }
    }
    yield { type: 'done', stopReason: r.stop_reason };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => streamOne(responses[i++] ?? responses[responses.length - 1])),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentExecutor', () => {
  it('多步循环正常终止并返回 finalText', async () => {
    const llm = makeMockLLM([
      { content: [{ type: 'tool_use', id: 'a', name: 'foo', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);
    const res = await runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({ foo: { success: true, content: 'ok' } }),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
    });
    expect(res.stopReason).toBe('end_turn');
    expect(res.finalText).toBe('done');
    expect(res.stepsUsed).toBe(1);
  });

  it('onStepComplete：在 continue 步调、max_tokens_tool_use 不调', async () => {
    let callCount = 0;
    const llm = makeMockLLM([
      { content: [{ type: 'tool_use', id: 'a', name: 'foo', input: {} }], stop_reason: 'max_tokens' },  // 不触发
      { content: [{ type: 'tool_use', id: 'b', name: 'foo', input: {} }], stop_reason: 'tool_use' },   // 触发
      { content: [{ type: 'text', text: 'end' }], stop_reason: 'end_turn' },                           // 不触发
    ]);
    await runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({ foo: { success: true, content: 'ok' } }),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
      onStepComplete: async () => { callCount++; },
    });
    expect(callCount).toBe(1);
  });

  it('stepCount 达 maxSteps 抛 MaxStepsExceededError', async () => {
    const llm = makeMockLLM([
      { content: [{ type: 'tool_use', id: 'x', name: 'foo', input: {} }], stop_reason: 'tool_use' },
    ]);  // 永远 tool_use
    await expect(runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({ foo: { success: true, content: 'ok' } }),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
      maxSteps: 3,
    })).rejects.toThrow(MaxStepsExceededError);
  });

  it('max_tokens_tool_use：stepCount++、不调 onStepComplete', async () => {
    let callCount = 0;
    const llm = makeMockLLM([
      { content: [{ type: 'tool_use', id: 'a', name: 'foo', input: {} }], stop_reason: 'max_tokens' },
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    ]);
    const res = await runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
      onStepComplete: async () => { callCount++; },
    });
    expect(res.stepsUsed).toBe(1);
    expect(callCount).toBe(0);
  });
});

describe('runAgent circuit breaker thresholds (caller injection)', () => {
  it('should respect caller-injected maxConsecutiveParseErrors', async () => {
    // 注入 thresholds = 1 / 第 1 次 parse error 即抛
    const responses = Array(1).fill(null).map(() => ({
      content: [{ type: 'tool_use' as const, id: 'x', name: 'foo', input: {} }],
      stop_reason: 'tool_use' as const,
    }));
    const llm = makeMalformedSequenceLLM(responses);
    await expect(runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
      maxConsecutiveParseErrors: 1,
    })).rejects.toThrow(ConsecutiveParseErrorsExceededError);
  });

  it('should fallback to constants.ts default when caller does not inject parse error threshold', async () => {
    const responses = Array(MAX_CONSECUTIVE_PARSE_ERRORS).fill(null).map(() => ({
      content: [{ type: 'tool_use' as const, id: 'x', name: 'foo', input: {} }],
      stop_reason: 'tool_use' as const,
    }));
    const llm = makeMalformedSequenceLLM(responses);
    await expect(runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
    })).rejects.toThrow(/工具输入 JSON 连续解析失败/);
  });

  it('should respect caller-injected maxConsecutiveMaxTokensToolUse', async () => {
    // 注入 = 1 / 第 1 次 max_tokens_tool_use 即抛
    const responses = Array(1).fill(null).map(() => ({
      content: [{ type: 'tool_use' as const, id: 'x', name: 'foo', input: {} }],
      stop_reason: 'max_tokens' as const,
    }));
    const llm = makeMockLLM(responses);
    await expect(runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
      maxConsecutiveMaxTokensToolUse: 1,
    })).rejects.toThrow(ConsecutiveMaxTokensToolUseError);
  });

  it('should fallback to constants.ts default when caller does not inject maxTokensToolUse threshold', async () => {
    const responses = Array(MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE).fill(null).map(() => ({
      content: [{ type: 'tool_use' as const, id: 'x', name: 'foo', input: {} }],
      stop_reason: 'max_tokens' as const,
    }));
    const llm = makeMockLLM(responses);
    await expect(runReact({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}),
      registry: makeRegistry({ foo: { readonly: false } }),
      ctx: makeCtx(),
    })).rejects.toThrow(/max_tokens 截断 tool_use/);
  });
});
