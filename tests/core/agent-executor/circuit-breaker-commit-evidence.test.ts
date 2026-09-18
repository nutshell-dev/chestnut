/**
 * phase 1856 AE-D3: 熔断前形成完整 step 提交证据。
 *
 * 修前顺序（continue 分支）：步进 → 熔断判定（超限 throw）→ step audit → onAfterStep；
 * max_tokens 分支：计数与熔断（超限 throw）→ 步进 → audit → onAfterStep。
 * 熔断抛出时，最后一个已修改 messages 的 step 没有 step audit / 持久化 hook。
 *
 * 修后两分支同序：步进 → stepCompleted 事件 → onAfterStep → 计数与熔断。
 * guard 终态不被吞（仍 throw），但证据已落定。
 * （phase 1856 AE-D9 后：step 完成证据经 AgentExecutorEventSink 结构化事件观测。）
 */

import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import {
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
} from '../../../src/core/agent-executor/errors.js';
import type { AgentExecutorEventSink } from '../../../src/core/agent-executor/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeParseErrorLLM(): LLMOrchestrator {
  async function* stream(): AsyncIterableIterator<unknown> {
    yield { type: 'tool_use_start', toolUse: { id: 't1', name: 'exec', partialInput: '' } };
    // 非法 JSON → stream-side parse error → allParseErrors continue
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"content":"partial' } };
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

function makeMaxTokensLLM(): LLMOrchestrator {
  async function* stream(): AsyncIterableIterator<unknown> {
    yield { type: 'tool_use_start', toolUse: { id: 't1', name: 'exec', partialInput: '' } };
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } };
    yield { type: 'done', stopReason: 'max_tokens' };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => stream()),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

function makeNoopExecutor(): IToolExecutor {
  return {
    execute: vi.fn(async () => ({ success: true, content: 'ok' })),
    executeParallel: vi.fn(),
    validateArgs: vi.fn(),
  } as unknown as IToolExecutor;
}

function makeEventSink(): AgentExecutorEventSink & { stepCompleted: ReturnType<typeof vi.fn> } {
  return {
    toolCallInput: vi.fn(),
    toolResult: vi.fn(),
    stepCompleted: vi.fn(),
  };
}

describe('熔断前完整 step 提交证据（phase 1856 AE-D3）', () => {
  it('parse-error 熔断抛出前：onAfterStep 已含该 step、stepCompleted 事件已发', async () => {
    const onStepComplete = vi.fn(async () => {});
    const eventSink = makeEventSink();

    await expect(
      runReact({
        messages: [],
        systemPrompt: '',
        llm: makeParseErrorLLM(),
        tools: [],
        executor: makeNoopExecutor(),
        ctx: makeExecContext(),
        maxConsecutiveParseErrors: 2,
        onStepComplete,
        eventSink,
      }),
    ).rejects.toThrow(ConsecutiveParseErrorsExceededError);

    // 熔断步（step 2）的提交证据已落定
    expect(onStepComplete).toHaveBeenCalledTimes(2);
    expect(onStepComplete).toHaveBeenNthCalledWith(2, 2);
    expect(eventSink.stepCompleted).toHaveBeenCalledTimes(2);
    expect(eventSink.stepCompleted).toHaveBeenNthCalledWith(2, { step: 2 });
  });

  it('max_tokens 熔断抛出前：onAfterStep 已含该 step、stepCompleted 事件已发（两分支同序）', async () => {
    const onStepComplete = vi.fn(async () => {});
    const eventSink = makeEventSink();

    await expect(
      runReact({
        messages: [],
        systemPrompt: '',
        llm: makeMaxTokensLLM(),
        tools: [],
        executor: makeNoopExecutor(),
        ctx: makeExecContext(),
        maxConsecutiveMaxTokensToolUse: 2,
        onStepComplete,
        eventSink,
      }),
    ).rejects.toThrow(ConsecutiveMaxTokensToolUseError);

    expect(onStepComplete).toHaveBeenCalledTimes(2);
    expect(onStepComplete).toHaveBeenNthCalledWith(2, 2);
    expect(eventSink.stepCompleted).toHaveBeenCalledTimes(2);
    expect(eventSink.stepCompleted).toHaveBeenNthCalledWith(2, { step: 2 });
  });
});
