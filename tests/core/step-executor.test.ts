/**
 * StepExecutor single-step contract tests
 *
 * Directly tests executeStep without going through runReact shim.
 */

import { describe, it, expect, vi } from 'vitest';
import { executeStep } from '../../src/core/react/step-executor.js';
import type { LLMService } from '../../src/foundation/llm/index.js';
import type { StreamChunk } from '../../src/foundation/llm/types.js';
import type { LLMResponse, Message } from '../../src/types/message.js';
import type { IToolExecutor, ExecContext, ToolRegistry, ToolResult } from '../../src/core/tools/executor.js';

// ── Mock factories ──────────────────────────────────────────────────────────

function makeMockLLM(responses: LLMResponse[]): LLMService {
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
  } as unknown as LLMService;
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
  return {
    clawId: 'test-claw',
    clawDir: '/test',
    profile: 'full',
    fs: {} as any,
    stepNumber: 0,
    maxSteps: 20,
    getElapsedMs: () => 0,
    incrementStep: vi.fn(function (this: { stepNumber: number }) { this.stepNumber++; }),
  } as unknown as ExecContext;
}

/** Yield tool_use_start + tool_use_delta with malformed JSON input */
function makeMalformedToolInputLLM(toolUseId: string, toolName: string, rawInput: string): LLMService {
  async function* stream(): AsyncIterableIterator<StreamChunk> {
    yield {
      type: 'tool_use_start',
      toolUse: { id: toolUseId, name: toolName, partialInput: '' },
    };
    yield {
      type: 'tool_use_delta',
      toolUse: { id: '', name: '', partialInput: rawInput },
    };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => stream()),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMService;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StepExecutor', () => {
  it('kind=final (end_turn)：LLM 直接返回 end_turn 的纯文本', async () => {
    const llm = makeMockLLM([{
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
    }]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(result.kind).toBe('final');
    if (result.kind === 'final') {
      expect(result.stopReason).toBe('end_turn');
      expect(result.finalText).toBe('hello');
    }
    expect(messages).toHaveLength(1);  // assistant 消息已追加
  });

  it('kind=continue：tool_use 后追加 messages 并返回 meta', async () => {
    const llm = makeMockLLM([{
      content: [{ type: 'tool_use', id: 'tu1', name: 'foo', input: { a: 1 } }],
      stop_reason: 'tool_use',
    }]);
    const exec = makeExecutor({ foo: { success: true, content: 'ok' } });
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
    });
    expect(result.kind).toBe('continue');
    if (result.kind === 'continue') {
      expect(result.meta.toolCallCount).toBe(1);
      expect(result.meta.parseErrorCount).toBe(0);
      expect(result.meta.allParseErrors).toBe(false);
      expect(result.meta.llm.model).toBe('mock-model');
    }
    expect(messages).toHaveLength(2);  // assistant tool_use + user tool_result
  });

  it('kind=max_tokens_tool_use：max_tokens + tool_use 时补 TRUNCATED tool_result', async () => {
    const llm = makeMockLLM([{
      content: [{ type: 'tool_use', id: 'tu1', name: 'foo', input: { a: 1 } }],
      stop_reason: 'max_tokens',
    }]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
    });
    expect(result.kind).toBe('max_tokens_tool_use');
    // tool_result 是 TRUNCATED 且未实际执行工具
    const lastMsg = messages[messages.length - 1];
    expect(String(JSON.stringify(lastMsg))).toContain('[TRUNCATED]');
  });

  it('kind=context_window_exceeded：stop_reason 匹配两种变体', async () => {
    for (const sr of ['model_context_window_exceeded', 'context_length_exceeded'] as const) {
      const llm = makeMockLLM([{ content: [{ type: 'text', text: '' }], stop_reason: sr }]);
      const result = await executeStep({
        messages: [], systemPrompt: '', llm, tools: [],
        executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      });
      expect(result.kind).toBe('context_window_exceeded');
    }
  });

  it('meta.allParseErrors：输入 JSON 解析失败时元数据正确', async () => {
    // 构造一个 stream 使 tool_use_delta 的 partialInput 不是合法 JSON
    // → collectStreamResponse 内 JSON.parse 失败 → input = { __parseError: true }
    // → executeSingleTool 直接返回 metadata.parseError=true 的 ToolResult
    const llm = makeMalformedToolInputLLM('tu1', 'foo', '{not json');
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
    });
    expect(result.kind).toBe('continue');
    if (result.kind === 'continue') {
      expect(result.meta.parseErrorCount).toBe(1);
      expect(result.meta.allParseErrors).toBe(true);
    }
  });

  it('parallel 分支的 parseError：readonly 工具走 parallel 时 parse 失败仍熔断计数', async () => {
    const llm = makeMalformedToolInputLLM('tu1', 'readFile', '{not json');
    const exec = makeExecutor({});
    // 关键：readonly=true 才会进入 parallel 分支
    const registry = makeRegistry({ readFile: { readonly: true } });
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: exec, registry, ctx: makeCtx(),
    });
    expect(result.kind).toBe('continue');
    if (result.kind === 'continue') {
      expect(result.meta.parseErrorCount).toBe(1);
      expect(result.meta.allParseErrors).toBe(true);
    }
    // executeParallel 不应被调用（parseError 调用被 executeSingleTool 截获）
    expect(exec.executeParallel).not.toHaveBeenCalled();
  });
});
