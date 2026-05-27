/**
 * StepExecutor single-step contract tests
 *
 * Directly tests executeStep without going through runReact shim.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeStep } from '../../src/core/step-executor/step-executor.js';
import { IdleTimeoutSignal } from '../../src/core/signals.js';
import type { LLMCallInfo } from '../../src/core/step-executor/step-executor.js';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { StreamChunk } from '../../src/foundation/llm-orchestrator/types.js';
import type { LLMResponse, Message } from '../../src/foundation/llm-provider/types.js';
import type { ExecContext, ToolResult, Tool } from '../../src/foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../src/foundation/tools/executor.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../src/foundation/tools/executor.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { makeExecContext } from '../helpers/exec-context.js';
import { TEST_LLM_TIMEOUT_MS } from '../helpers/test-timeouts.js';

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

/** Yield two tool_use blocks; first has malformed JSON, second is valid */
function makeMidStreamMalformedLLM(): LLMOrchestrator {
  async function* stream(): AsyncIterableIterator<StreamChunk> {
    // First tool_use: malformed JSON
    yield { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'foo', partialInput: '' } };
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{not json' } };
    // Second tool_use: triggers mid-stream flush of first
    yield { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'bar', partialInput: '' } };
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"b":2}' } };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => stream()),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

/** Yield tool_use_start + tool_use_delta with malformed JSON input */
function makeMalformedToolInputLLM(toolUseId: string, toolName: string, rawInput: string): LLMOrchestrator {
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
  } as unknown as LLMOrchestrator;
}

// ── Real fixture factories (fidelity) ───────────────────────────────────────

const tmpDirs: string[] = [];

async function makeRealCtx(opts: { signal?: AbortSignal } = {}): Promise<ExecContext> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-exec-'));
  tmpDirs.push(tmpDir);
  const nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  return new ExecContextImpl({
    clawId: 'test-claw',
    clawDir: tmpDir,
    profile: 'full',
    fs: nodeFs,
    signal: opts.signal,
  });
}

// phase 999 r121 P fork C.D.2: cleanup tmpDir leak per test run (async variant)
afterEach(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

function makeStreamLLM(chunks: StreamChunk[]): LLMOrchestrator {
  return {
    call: vi.fn(),
    stream: vi.fn(() => (async function* () { for (const c of chunks) yield c; })()),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

function makeTool(name: string, fn: (args: Record<string, unknown>, ctx: ExecContext) => Promise<ToolResult>, readonly = false): Tool {
  return {
    name,
    description: 'test tool',
    schema: { type: 'object', properties: {} },
    readonly,
    idempotent: true,
    execute: fn,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StepExecutor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

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

  it('meta.allParseErrors：输入 JSON 解析失败时元数据正确', async () => {
    // 构造一个 stream 使 tool_use_delta 的 partialInput 不是合法 JSON
    // → collectStreamResponse 内 JSON.parse 失败 → 生成 tool_result error block
    // → stop-handlers 统计为 parseError
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

  it('mid-stream tool_use parse 失败：第一个 tool_use JSON 非法，stream 不崩', async () => {
    const llm = makeMidStreamMalformedLLM();
    const exec = makeExecutor({ bar: { success: true, content: 'ok2' } });
    // 两个都 readonly=false，走 sequential 分支（隔离 Step 1 改动）
    const registry = makeRegistry({ foo: { readonly: false }, bar: { readonly: false } });
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: exec, registry, ctx: makeCtx(),
    });
    // 1. 不抛 SyntaxError
    expect(result.kind).toBe('continue');
    if (result.kind === 'continue') {
      // 2. 第一个 tool_use 被归因为 parseError
      expect(result.meta.parseErrorCount).toBe(1);
      expect(result.meta.toolCallCount).toBe(2);
      expect(result.meta.allParseErrors).toBe(false);  // 只有一个失败
    }
    // 3. 第二个工具被真实调用
    expect(exec.execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'bar' }));
    // 4. 第一个工具未真实调用（parse error 在 stream 层已处理为 tool_result）
    expect(exec.execute).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: 'foo' }));
  });

  it('onLLMResult.error contains JSON fields when LLM throws a non-Error object', async () => {
    const plainObjError = { code: 'ECONNRESET', detail: 'connection reset' };
    const llm = makeMockLLM([{ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' }]);
    llm.stream.mockImplementationOnce(() => {
      async function* gen(): AsyncIterableIterator<StreamChunk> {
        throw plainObjError;
      }
      return gen();
    });

    const results: LLMCallInfo[] = [];
    await expect(
      executeStep({
        messages: [], systemPrompt: '', llm, tools: [],
        executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
        callbacks: { onLLMResult: (info) => results.push(info) },
      })
    ).rejects.toThrow();

    expect(results).toHaveLength(1);
    expect(results[0].error).not.toBe('[object Object]');
    expect(results[0].error).toContain('ECONNRESET');
  });

  it('abort during tool_use stream throws immediately without executing tool', async () => {
    const abortController = new AbortController();

    async function* stream(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'testTool', partialInput: '' } };
      yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"key":"value"}' } };
      abortController.abort({ type: 'idle_timeout', ms: 120000 });
      throw new Error('Execution aborted');
    }

    const llm = {
      call: vi.fn(),
      stream: vi.fn(() => stream()),
      healthCheck: vi.fn(async () => true),
      getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
      close: vi.fn(),
    } as unknown as LLMOrchestrator;

    const exec = {
      execute: vi.fn(async () => ({ success: true, content: 'done' })),
      executeParallel: vi.fn(),
      validateArgs: vi.fn(),
    } as unknown as IToolExecutor;

    const ctx = { ...makeCtx(), signal: abortController.signal };

    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({ testTool: { readonly: false } }), ctx,
    })).rejects.toThrow(IdleTimeoutSignal);

    // Phase 538: abort 期 stream 一致 throwAbortError / partial tool_use 丢弃 / 工具不执行
    expect(exec.execute).not.toHaveBeenCalled();
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // A. executeStep boundary coverage
  // ═════════════════════════════════════════════════════════════════════════════

  it('empty response triggers onEmptyResponse callback', async () => {
    const llm = makeStreamLLM([{ type: 'done', stopReason: 'end_turn' }]);
    const emptyReasons: string[] = [];
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onEmptyResponse: (reason) => emptyReasons.push(reason) },
    });
    expect(result.kind).toBe('final');
    expect(emptyReasons).toEqual(['end_turn']);
  });

  it('empty response without callback silently skips', async () => {
    const llm = makeStreamLLM([{ type: 'done', stopReason: 'end_turn' }]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('max_tokens with tool_calls returns max_tokens_tool_use meta', async () => {
    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'foo', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"a":1}' } },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
    });
    expect(result.kind).toBe('max_tokens_tool_use');
    if (result.kind === 'max_tokens_tool_use') {
      expect(result.meta.toolCallCount).toBe(1);
      expect(result.meta.parseErrorCount).toBe(0);
    }
    expect(messages).toHaveLength(2);
    const toolResults = messages[1].content as Array<{ type: string; content?: string }>;
    expect(toolResults[0].content).toContain('[TRUNCATED]');
  });

  it('max_tokens text-only returns final with truncation suffix', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'partial' },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(result.kind).toBe('final');
    if (result.kind === 'final') {
      expect(result.stopReason).toBe('max_tokens_text');
      expect(result.finalText).toContain('[Response truncated due to length limit]');
    }
  });

  it('unknown stop_reason triggers onUnknownStopReason callback', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'hello' },
      { type: 'done', stopReason: 'custom_reason' },
    ]);
    const unknownReasons: string[] = [];
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onUnknownStopReason: (r) => unknownReasons.push(r) },
    });
    expect(result.kind).toBe('final');
    expect(unknownReasons).toEqual(['custom_reason']);
  });

  it('unknown stop_reason without callback silently skips', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'hello' },
      { type: 'done', stopReason: 'custom_reason' },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('tool_use with zero parseable calls triggers onUnparseableToolUse callback', async () => {
    const llm = makeStreamLLM([
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const reasons: string[] = [];
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onUnparseableToolUse: (r) => reasons.push(r) },
    });
    expect(result.kind).toBe('final');
    expect(reasons).toEqual(['tool_use']);
  });

  it('tool_use with zero parseable calls without callback silently finalizes', async () => {
    const llm = makeStreamLLM([
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(result.kind).toBe('final');
  });

  it('tool_use with zero parseable calls with only onEmptyResponse still finalizes', async () => {
    const llm = makeStreamLLM([
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const emptyReasons: string[] = [];
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onEmptyResponse: (r) => emptyReasons.push(r) },
    });
    expect(result.kind).toBe('final');
    expect(emptyReasons).toEqual(['tool_use']);
  });

  it('LLM stream error emits onLLMResult with error and rethrows', async () => {
    const err = new Error('network failure');
    const llm = makeStreamLLM([]);
    llm.stream = vi.fn(() => (async function* () { throw err; })());
    const infos: LLMCallInfo[] = [];
    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onLLMResult: (info) => infos.push(info) },
    })).rejects.toThrow('network failure');
    expect(infos).toHaveLength(1);
    expect(infos[0].error).toBe('network failure');
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // B. collectStreamResponse boundary coverage
  // ═════════════════════════════════════════════════════════════════════════════

  it('text-only stream produces a single text block', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'hello world' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(result.kind).toBe('final');
    expect(messages).toHaveLength(1);
    const blocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('hello world');
  });

  it('thinking-only stream produces a single thinking block', async () => {
    const llm = makeStreamLLM([
      { type: 'thinking_delta', delta: 'planning...' },
      { type: 'thinking_signature', signature: 'sig123' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(result.kind).toBe('final');
    const blocks = messages[0].content as Array<{ type: string; thinking?: string; signature?: string }>;
    expect(blocks[0].type).toBe('thinking');
    expect(blocks[0].thinking).toBe('planning...');
    expect(blocks[0].signature).toBe('sig123');
  });

  it('thinking followed by text yields two blocks in order', async () => {
    const llm = makeStreamLLM([
      { type: 'thinking_delta', delta: 'think' },
      { type: 'text_delta', delta: 'text' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const messages: Message[] = [];
    await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    const blocks = messages[0].content as Array<{ type: string }>;
    expect(blocks.map(b => b.type)).toEqual(['thinking', 'text']);
  });

  it('text interrupted by tool_use triggers onTextEnd callback', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'partial text' },
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'foo', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"a":1}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    let textEndCount = 0;
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({ foo: { success: true, content: 'ok' } }),
      registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
      callbacks: { onTextEnd: () => textEndCount++ },
    });
    expect(textEndCount).toBe(1);
  });

  it('mid-stream reset clears contentBlocks and triggers onReset callback', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'old' },
      { type: 'reset', provider: 'openai', timeoutMs: TEST_LLM_TIMEOUT_MS },
      { type: 'text_delta', delta: 'new' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const resets: Array<{ provider: string; timeoutMs: number }> = [];
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onReset: (p, t) => resets.push({ provider: p, timeoutMs: t }) },
    });
    expect(result.kind).toBe('final');
    expect(resets).toHaveLength(1);
    expect(resets[0].provider).toBe('openai');
    // old text should be discarded; only new remains
    const blocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('new');
  });

  it('mid-stream reset isolates subsequent stream from prior state', async () => {
    const llm = makeStreamLLM([
      { type: 'thinking_delta', delta: 'old think' },
      { type: 'reset', provider: 'anthropic', timeoutMs: 15000 },
      { type: 'thinking_delta', delta: 'new think' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const messages: Message[] = [];
    await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    const blocks = messages[0].content as Array<{ type: string; thinking?: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe('new think');
  });

  it('mid-stream reset without onReset callback silently resets state', async () => {
    const llm = makeStreamLLM([
      { type: 'text_delta', delta: 'old' },
      { type: 'reset', provider: 'openai', timeoutMs: TEST_LLM_TIMEOUT_MS },
      { type: 'text_delta', delta: 'new' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
    });
    expect(result.kind).toBe('final');
  });

  it('provider_failed chunk triggers onProviderFailed callback', async () => {
    const llm = makeStreamLLM([
      { type: 'provider_failed', provider: 'openai', model: 'gpt-4', error: 'rate limited' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const failures: Array<{ p: string; m: string; e: string }> = [];
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: makeCtx(),
      callbacks: { onProviderFailed: (p, m, e) => failures.push({ p, m, e }) },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].p).toBe('openai');
    expect(failures[0].e).toBe('rate limited');
  });

  it('tool_use_delta accumulates partial input and parses correctly', async () => {
    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'foo', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"a"' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: ':1}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const messages: Message[] = [];
    const exec = makeExecutor({ foo: { success: true, content: 'ok' } });
    await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
    });
    expect(exec.execute).toHaveBeenCalledWith(expect.objectContaining({ args: { a: 1 } }));
  });

  it('malformed tool_use JSON is handled at stream layer, no execute called', async () => {
    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'foo', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{bad' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const exec = makeExecutor({ foo: { success: true, content: 'ok' } });
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: exec, registry: makeRegistry({ foo: { readonly: false } }), ctx: makeCtx(),
    });
    // execute should NOT be called because parse error is handled in stream.ts
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it('abort during non-tool_use stream throws AbortError immediately', async () => {
    const abortController = new AbortController();
    const llm = makeStreamLLM([]);
    llm.stream = vi.fn(() => (async function* () {
      yield { type: 'text_delta', delta: 'hello' };
      abortController.abort();
      yield { type: 'text_delta', delta: 'world' };
    })());
    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor: makeExecutor({}), registry: makeRegistry({}), ctx: { ...makeCtx(), signal: abortController.signal },
    })).rejects.toThrow();
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // C. executeToolCalls grouping coverage (real fixtures)
  // ═════════════════════════════════════════════════════════════════════════════

  it('no registry falls back to sequential execution', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    registry.register(makeTool('echo', async (args) => ({ success: true, content: String(args.msg) })));
    const executor = new ToolExecutorImpl(registry);

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'echo', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"msg":"hi"}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const messages: Message[] = [];
    const result = await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor, registry: undefined, ctx,
    });
    expect(result.kind).toBe('continue');
    expect(messages).toHaveLength(2);
  });

  it('readonly+async tools go through executeParallel in their own batch before sync parallel batch', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    const order: string[] = [];
    registry.register(makeTool('asyncA', async () => { order.push('asyncA'); return { success: true, content: 'a' }; }, true));
    registry.register(makeTool('syncB', async () => { order.push('syncB'); return { success: true, content: 'b' }; }, true));

    const executor = new ToolExecutorImpl(registry);
    // mock executeParallel to track invocation
    const origParallel = executor.executeParallel.bind(executor);
    executor.executeParallel = vi.fn(async (batch, _ctx) => {
      order.push('parallel-start');
      const res = await origParallel(batch, _ctx);
      order.push('parallel-end');
      return res;
    });

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'asyncA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"async":true}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'syncB', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    // asyncA now goes through executeParallel (readonlyAsync batch)
    // async batch runs before sync batch
    expect(order).toEqual([
      'parallel-start', 'asyncA', 'parallel-end',
      'parallel-start', 'syncB', 'parallel-end',
    ]);
  });

  it('readonly+sync clean calls go through executeParallel', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    registry.register(makeTool('readA', async () => ({ success: true, content: 'a' }), true));
    registry.register(makeTool('readB', async () => ({ success: true, content: 'b' }), true));

    const executor = new ToolExecutorImpl(registry);
    const parallelSpy = vi.spyOn(executor, 'executeParallel');

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'readA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'readB', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    expect(parallelSpy).toHaveBeenCalledTimes(1);
    expect(parallelSpy.mock.calls[0][0]).toHaveLength(2);
  });

  it('readonly+sync parseError calls bypass executeParallel and return error', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    registry.register(makeTool('readA', async () => ({ success: true, content: 'a' }), true));

    const executor = new ToolExecutorImpl(registry);
    const parallelSpy = vi.spyOn(executor, 'executeParallel');

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'readA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{bad' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const result = await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    expect(parallelSpy).not.toHaveBeenCalled();
    expect(result.kind).toBe('continue');
    if (result.kind === 'continue') {
      expect(result.meta.parseErrorCount).toBe(1);
      expect(result.meta.allParseErrors).toBe(true);
    }
  });

  it('write tools run sequentially', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    const order: string[] = [];
    registry.register(makeTool('writeA', async () => { order.push('writeA'); return { success: true, content: 'a' }; }, false));
    registry.register(makeTool('writeB', async () => { order.push('writeB'); return { success: true, content: 'b' }; }, false));

    const executor = new ToolExecutorImpl(registry);

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'writeA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'writeB', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    expect(order).toEqual(['writeA', 'writeB']);
  });

  it('mixed three categories execute in order: async parallel → sync parallel → write', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    const order: string[] = [];
    registry.register(makeTool('asyncA', async () => { order.push('asyncA'); return { success: true, content: 'a' }; }, true));
    registry.register(makeTool('syncB', async () => { order.push('syncB'); return { success: true, content: 'b' }; }, true));
    registry.register(makeTool('writeC', async () => { order.push('writeC'); return { success: true, content: 'c' }; }, false));

    const executor = new ToolExecutorImpl(registry);
    const origParallel = executor.executeParallel.bind(executor);
    executor.executeParallel = vi.fn(async (batch, _ctx) => {
      order.push('parallel');
      return origParallel(batch, _ctx);
    });

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'writeC', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'asyncA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"async":true}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu3', name: 'syncB', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    // asyncA runs in first parallel batch; syncB runs in second parallel batch; writeC runs sequentially last
    expect(order.indexOf('asyncA')).toBeLessThan(order.indexOf('syncB'));
    expect(order.indexOf('syncB')).toBeLessThan(order.indexOf('writeC'));
  });

  it('results map preserves original toolCalls index order', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    // readB is readonly (executes first via parallel) but placed at index 1
    // writeA is write (executes last) but placed at index 0
    registry.register(makeTool('writeA', async () => ({ success: true, content: 'write' }), false));
    registry.register(makeTool('readB', async () => ({ success: true, content: 'read' }), true));

    const executor = new ToolExecutorImpl(registry);

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'writeA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'readB', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    const messages: Message[] = [];
    await executeStep({
      messages, systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    const toolResults = messages[1].content as Array<{ type: string; content?: string }>;
    // toolCalls order: writeA (index 0), readB (index 1)
    // execution order: readB (parallel) then writeA (sequential)
    // assemble must restore original index order
    expect(toolResults[0].content).toBe('write');
    expect(toolResults[1].content).toBe('read');
  });

  it('mid-execution abort throws after prior tools completed', async () => {
    const abortController = new AbortController();
    const ctx = await makeRealCtx({ signal: abortController.signal });
    const registry = new ToolRegistryImpl();
    registry.register(makeTool('fast', async () => ({ success: true, content: 'fast' }), false));
    registry.register(makeTool('slow', async () => {
      abortController.abort();
      return { success: true, content: 'slow' };
    }, false));

    const executor = new ToolExecutorImpl(registry);

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'fast', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'slow', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await expect(executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    })).rejects.toThrow();
  });

  it('onToolCall and onToolResult fire in correct order per tool', async () => {
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    registry.register(makeTool('toolA', async () => ({ success: true, content: 'a' }), false));

    const executor = new ToolExecutorImpl(registry);
    const events: string[] = [];

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'toolA', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
      callbacks: {
        onToolCall: () => events.push('call'),
        onToolResult: () => events.push('result'),
      },
    });
    expect(events).toEqual(['call', 'result']);
  });

  it('categorizeToolCalls partitions by readonly and async flag', async () => {
    // This helper is pure; we test it via the module import by exercising executeStep
    // with a registry that distinguishes the three paths.
    const ctx = await makeRealCtx();
    const registry = new ToolRegistryImpl();
    registry.register(makeTool('roSync', async () => ({ success: true, content: 's' }), true));
    registry.register(makeTool('roAsync', async () => ({ success: true, content: 'a' }), true));
    registry.register(makeTool('write', async () => ({ success: true, content: 'w' }), false));

    const executor = new ToolExecutorImpl(registry);
    const parallelSpy = vi.spyOn(executor, 'executeParallel');

    const llm = makeStreamLLM([
      { type: 'tool_use_start', toolUse: { id: 'tu1', name: 'roSync', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu2', name: 'roAsync', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"async":true}' } },
      { type: 'tool_use_start', toolUse: { id: 'tu3', name: 'write', partialInput: '' } },
      { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    await executeStep({
      messages: [], systemPrompt: '', llm, tools: [],
      executor, registry, ctx,
    });
    // roAsync and roSync each go through parallel in separate batches
    expect(parallelSpy).toHaveBeenCalledTimes(2);
    expect(parallelSpy.mock.calls[0][0]).toHaveLength(1); // roAsync batch
    expect(parallelSpy.mock.calls[1][0]).toHaveLength(1); // roSync batch
  });
});
