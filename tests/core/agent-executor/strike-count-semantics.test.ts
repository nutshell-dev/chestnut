/**
 * phase 1856 AE-D4: consecutive 计数语义统一为 strike（自上次成功起累计、另类失败不重置）。
 *
 * 锁定所选语义：parse_err → max_tokens → parse_err 交替序列中 parse strike 累计=2 触发熔断；
 * 反向同理；成功步双清不变。阈值/触发点与旧行为逐位一致（仅命名/文案/注释诚实化）。
 */

import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import {
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
  MaxStepsExceededError,
} from '../../../src/core/agent-executor/errors.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

type StepKind = 'parse_error' | 'max_tokens' | 'success';

function makeScriptedLLM(script: StepKind[]): LLMOrchestrator {
  let calls = 0;
  async function* parseErrorStream(): AsyncIterableIterator<unknown> {
    yield { type: 'tool_use_start', toolUse: { id: 't1', name: 'exec', partialInput: '' } };
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{"content":"partial' } };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  async function* maxTokensStream(): AsyncIterableIterator<unknown> {
    yield { type: 'tool_use_start', toolUse: { id: 't1', name: 'exec', partialInput: '' } };
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } };
    yield { type: 'done', stopReason: 'max_tokens' };
  }
  async function* successStream(): AsyncIterableIterator<unknown> {
    yield { type: 'tool_use_start', toolUse: { id: 't1', name: 'exec', partialInput: '' } };
    yield { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: '{}' } };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => {
      const kind = script[Math.min(calls++, script.length - 1)];
      return kind === 'parse_error' ? parseErrorStream() : kind === 'max_tokens' ? maxTokensStream() : successStream();
    }),
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

function baseOptions(script: StepKind[]) {
  return {
    messages: [] as never[],
    systemPrompt: '',
    llm: makeScriptedLLM(script),
    tools: [],
    executor: makeNoopExecutor(),
    ctx: makeExecContext(),
  };
}

describe('strike 计数语义（phase 1856 AE-D4）', () => {
  it('parse → max_tokens → parse：另类失败不重置，parse strike 累计=2 触发熔断', async () => {
    await expect(
      runReact({
        ...baseOptions(['parse_error', 'max_tokens', 'parse_error']),
        maxConsecutiveParseErrors: 2,
      }),
    ).rejects.toThrow(ConsecutiveParseErrorsExceededError);
  });

  it('max_tokens → parse → max_tokens：另类失败不重置，max_tokens strike 累计=2 触发熔断', async () => {
    await expect(
      runReact({
        ...baseOptions(['max_tokens', 'parse_error', 'max_tokens']),
        maxConsecutiveMaxTokensToolUse: 2,
      }),
    ).rejects.toThrow(ConsecutiveMaxTokensToolUseError);
  });

  it('parse → success → parse：成功步双清，strike 重新累计不触发熔断', async () => {
    // maxSteps=3 收口：若成功步未双清，第 3 步 parse strike=2 会抛 ConsecutiveParseErrorsExceededError；
    // 双清语义下应走完 3 步抛 MaxStepsExceededError。
    await expect(
      runReact({
        ...baseOptions(['parse_error', 'success', 'parse_error']),
        maxConsecutiveParseErrors: 2,
        maxSteps: 3,
      }),
    ).rejects.toThrow(MaxStepsExceededError);
  });
});
