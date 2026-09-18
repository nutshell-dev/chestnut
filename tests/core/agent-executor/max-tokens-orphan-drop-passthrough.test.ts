/**
 * phase 1856 AE-D2: onMaxTokensStateAOrphanDrop 完整透传（runReact 层观测）。
 *
 * 修前：loop.ts ReactOptions 声明了该回调，但 runReact 解构与 stepCallbacks 装配
 * 均未包含 → 经 runReact 传入的 spy 永不触发（step-executor 侧早已支持，
 * 触发条件覆盖见 tests/core/step-executor/tokens-invariants.test.ts）。
 *
 * 本文件只锁「透传接线」：mock executeStep 捕获 StepCallbacks，
 * 以 tokens-invariants 同款 payload 调用之，断言 runReact 层 spy 被透传调用。
 */

import { describe, it, expect, vi } from 'vitest';
import type { StepCallbacks } from '../../../src/core/step-executor/index.js';

let capturedCallbacks: StepCallbacks | undefined;

vi.mock('../../../src/core/step-executor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/step-executor/index.js')>();
  return {
    ...actual,
    executeStep: vi.fn(async (input: { callbacks?: StepCallbacks }) => {
      capturedCallbacks = input.callbacks;
      return { kind: 'final', finalText: 'done', stopReason: 'end_turn' };
    }),
  };
});

import { runReact } from '../../../src/core/agent-executor/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeNoopLLM(): LLMOrchestrator {
  return {
    call: vi.fn(),
    stream: vi.fn(),
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

describe('onMaxTokensStateAOrphanDrop 透传（phase 1856 AE-D2）', () => {
  it('经 runReact 传入的 spy 被透传至 StepCallbacks、参数含 orphans/llm', async () => {
    capturedCallbacks = undefined;
    const onMaxTokensStateAOrphanDrop = vi.fn();

    await runReact({
      messages: [],
      systemPrompt: '',
      llm: makeNoopLLM(),
      tools: [],
      executor: makeNoopExecutor(),
      ctx: makeExecContext(),
      stepCallbacks: { onMaxTokensStateAOrphanDrop },
    });

    expect(capturedCallbacks?.onMaxTokensStateAOrphanDrop).toBeDefined();

    // tokens-invariants.test.ts 同款 State A orphan payload
    const payload = {
      orphans: [{ tool_use_id: 'tc_orphan', content: 'real prior result', is_error: false }],
      llm: { model: 'test-model', inputTokens: 10, outputTokens: 10, latencyMs: 100 },
    };
    capturedCallbacks!.onMaxTokensStateAOrphanDrop!(payload);

    expect(onMaxTokensStateAOrphanDrop).toHaveBeenCalledTimes(1);
    expect(onMaxTokensStateAOrphanDrop).toHaveBeenCalledWith(payload);
  });

  it('不传时 StepCallbacks 对应项为 undefined（零调用面）', async () => {
    capturedCallbacks = undefined;

    await runReact({
      messages: [],
      systemPrompt: '',
      llm: makeNoopLLM(),
      tools: [],
      executor: makeNoopExecutor(),
      ctx: makeExecContext(),
    });

    expect(capturedCallbacks?.onMaxTokensStateAOrphanDrop).toBeUndefined();
  });
});
