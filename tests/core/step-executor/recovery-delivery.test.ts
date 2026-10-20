/**
 * Phase 1933 Step C: RecoveryDelivery 严格恢复事实交付测试。
 *
 * 验证严格通道的提交顺序与失败阻断语义：
 * - llmResponseCommitted 在任何副作用（工具执行 / messages 追加）前 await 提交；
 * - toolStarted 在 executor.execute 前、toolResultCommitted 在 execute 后按序提交；
 * - 任一提交失败传播、中止 step（不 catch、不降级、不重试）；
 * - 无 recovery 注入时行为与现状完全一致（回归）。
 */

import { describe, it, expect, vi } from 'vitest';
import { executeStep } from '../../../src/core/step-executor/step-executor.js';
import type { StepInput } from '../../../src/core/step-executor/types.js';
import type {
  RecoveryDelivery, CompleteLLMResponse, ToolStartedFact, ToolResultFact,
} from '../../../src/core/step-executor/recovery-delivery.js';
import {
  ToolResultDeliveryError, isToolResultDeliveryError,
} from '../../../src/core/step-executor/recovery-delivery.js';
import type { LLMOrchestrator, LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { IToolExecutor, ToolRegistry } from '../../../src/foundation/tools/index.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';

// ── Mock factories（沿用 callback-invariants.test.ts 惯例，不用 vi.mock） ─────

function makeToolUseLLM(tools: { id: string; name: string; input: Record<string, unknown> }[]): LLMOrchestrator {
  async function* streamOne(): AsyncIterableIterator<LLMStreamChunk> {
    for (const t of tools) {
      yield { type: 'tool_use_start', toolUse: { id: t.id, name: t.name, partialInput: '' } };
      yield { type: 'tool_use_delta', toolUse: { id: t.id, name: t.name, partialInput: JSON.stringify(t.input) } };
    }
    yield {
      type: 'done',
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  return {
    call: vi.fn(),
    stream: vi.fn(() => streamOne()),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'mock', model: 'mock-model', isFallback: false })),
    close: vi.fn(),
  } as unknown as LLMOrchestrator;
}

/** 调用日志型 executor：execute/executeParallel 进出均落 log。 */
function makeLoggingExecutor(log: string[]): IToolExecutor {
  return {
    execute: vi.fn(async ({ toolName }: { toolName: string }) => {
      log.push(`execute:${toolName}`);
      return { success: true, content: `${toolName}-ok` } as ToolResult;
    }),
    executeParallel: vi.fn(async (batch: { toolName: string }[]) => {
      log.push('executeParallel');
      return batch.map(b => ({ success: true, content: `${b.toolName}-ok` }) as ToolResult);
    }),
    validateArgs: vi.fn(() => ({ valid: true })),
    getToolSchema: vi.fn(),
  } as unknown as IToolExecutor;
}

interface RecoveryOverrides {
  failOnLLMResponse?: boolean;
  failOnStartedCount?: number;   // 第 N 次 toolStarted 调用时 reject（1-based）
  failOnResultCount?: number;    // 第 N 次 toolResultCommitted 调用时 reject（1-based）
}

/** 调用日志型 RecoveryDelivery：每次提交落 log + fact 记录；支持定点失败注入。 */
function makeLoggingRecovery(log: string[], overrides: RecoveryOverrides = {}) {
  const facts: { responses: CompleteLLMResponse[]; started: ToolStartedFact[]; results: ToolResultFact[] } = {
    responses: [], started: [], results: [],
  };
  const recovery: RecoveryDelivery = {
    llmResponseCommitted: vi.fn(async (fact: CompleteLLMResponse) => {
      log.push('llmResponseCommitted');
      facts.responses.push(fact);
      if (overrides.failOnLLMResponse) throw new Error('persist-llm-response-failed');
    }),
    toolStarted: vi.fn(async (fact: ToolStartedFact) => {
      log.push(`toolStarted:${fact.toolName}`);
      facts.started.push(fact);
      if (overrides.failOnStartedCount === facts.started.length) throw new Error('persist-tool-started-failed');
    }),
    toolResultCommitted: vi.fn(async (fact: ToolResultFact) => {
      log.push(`toolResultCommitted:${fact.toolName}`);
      facts.results.push(fact);
      if (overrides.failOnResultCount === facts.results.length) throw new Error('persist-tool-result-failed');
    }),
  };
  return { recovery, facts };
}

function makeStepInput(overrides: Partial<StepInput>): StepInput {
  return {
    messages: [] as Message[],
    systemPrompt: 'sys',
    llm: makeToolUseLLM([]),
    tools: [],
    executor: makeLoggingExecutor([]),
    ctx: makeExecContext(),
    ...overrides,
  };
}

const TWO_TOOLS = [
  { id: 'toolu_1', name: 'tool_a', input: { x: 1 } },
  { id: 'toolu_2', name: 'tool_b', input: { y: 2 } },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 1933 Step C: RecoveryDelivery 严格恢复交付', () => {
  it('顺序：llmResponseCommitted → started(1) → result(1) → started(2) → result(2)，started 早于对应 execute', async () => {
    const log: string[] = [];
    const { recovery, facts } = makeLoggingRecovery(log);
    const executor = makeLoggingExecutor(log);

    const result = await executeStep(makeStepInput({
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
      recovery,
      // 无 registry → executeSequential 串行路径
    }));

    expect(result.kind).toBe('continue');
    expect(log).toEqual([
      'llmResponseCommitted',
      'toolStarted:tool_a',
      'execute:tool_a',
      'toolResultCommitted:tool_a',
      'toolStarted:tool_b',
      'execute:tool_b',
      'toolResultCommitted:tool_b',
    ]);
    // 事实载荷：完整响应 + 工具意图（toolUseId/input）
    expect(facts.responses).toHaveLength(1);
    expect(facts.responses[0].response.stop_reason).toBe('tool_use');
    expect(facts.started.map(f => f.toolUseId)).toEqual(['toolu_1', 'toolu_2']);
    expect(facts.started[0].input).toEqual({ x: 1 });
    expect(facts.results.map(f => f.toolUseId)).toEqual(['toolu_1', 'toolu_2']);
    expect(facts.results[0].result).toEqual({ success: true, content: 'tool_a-ok' });
  });

  it('响应提交失败阻断：executeStep reject、execute 零调用、assistant 未追加', async () => {
    const log: string[] = [];
    const { recovery } = makeLoggingRecovery(log, { failOnLLMResponse: true });
    const executor = makeLoggingExecutor(log);
    const messages = [] as Message[];

    await expect(executeStep(makeStepInput({
      messages,
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
      recovery,
    }))).rejects.toThrow('persist-llm-response-failed');

    // 阻断不变量：提交失败 → 无任何副作用发生
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.executeParallel).not.toHaveBeenCalled();
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(0);
    expect(messages).toHaveLength(0);
    // started/result 事实均未提交
    expect(log).toEqual(['llmResponseCommitted']);
  });

  it('toolStarted 失败阻断：该工具未执行、后续工具未启动', async () => {
    const log: string[] = [];
    const { recovery } = makeLoggingRecovery(log, { failOnStartedCount: 1 });
    const executor = makeLoggingExecutor(log);

    await expect(executeStep(makeStepInput({
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
      recovery,
    }))).rejects.toThrow('persist-tool-started-failed');

    expect(executor.execute).not.toHaveBeenCalled();
    // 第 2 个工具连 started 都未提交
    expect(log).toEqual(['llmResponseCommitted', 'toolStarted:tool_a']);
  });

  it('toolResult 失败传播：工具已执行、executeStep reject、不重试', async () => {
    const log: string[] = [];
    const { recovery, facts } = makeLoggingRecovery(log, { failOnResultCount: 1 });
    const executor = makeLoggingExecutor(log);

    // Phase 1956 Step D：提交失败包成 typed ToolResultDeliveryError（携带 toolUseId），
    // 原始失败保留在 cause；副作用已发生一次且仅一次（不重试）。
    const failure = await executeStep(makeStepInput({
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
      recovery,
    })).then(
      () => { throw new Error('expected executeStep to reject'); },
      (err: unknown) => err,
    );

    expect(isToolResultDeliveryError(failure)).toBe(true);
    const deliveryError = failure as ToolResultDeliveryError;
    expect(String(deliveryError.toolUseId)).toBe('toolu_1');
    expect(deliveryError.toolName).toBe('tool_a');
    expect(deliveryError.cause).toBeInstanceOf(Error);
    expect((deliveryError.cause as Error).message).toBe('persist-tool-result-failed');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      'llmResponseCommitted',
      'toolStarted:tool_a',
      'execute:tool_a',
      'toolResultCommitted:tool_a',
    ]);
    // started 事实保持（不确定语义归实现方；此处断言提交记录不被重标/清除）
    expect(facts.started.map(f => f.toolUseId)).toEqual(['toolu_1']);
  });

  it('Phase 1956 D: 只读并行路径 toolResult 提交失败同样包成 typed delivery error（execute 仅一次）', async () => {
    const log: string[] = [];
    const { recovery } = makeLoggingRecovery(log, { failOnResultCount: 1 });
    const executor = makeLoggingExecutor(log);
    const registry = {
      get: () => ({ readonly: true }),
    } as unknown as ToolRegistry;

    const failure = await executeStep(makeStepInput({
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
      registry,
      recovery,
    })).then(
      () => { throw new Error('expected executeStep to reject'); },
      (err: unknown) => err,
    );

    expect(isToolResultDeliveryError(failure)).toBe(true);
    expect((failure as ToolResultDeliveryError).toolName).toBe('tool_a');
    // 批路径副作用恰好一次（executeParallel 单次），不重跑
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.executeParallel).toHaveBeenCalledTimes(1);
  });

  it('无 recovery 注入：行为与现状一致（回归——不提交、正常完成）', async () => {
    const log: string[] = [];
    const executor = makeLoggingExecutor(log);
    const messages = [] as Message[];

    const result = await executeStep(makeStepInput({
      messages,
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
    }));

    expect(result.kind).toBe('continue');
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['execute:tool_a', 'execute:tool_b']);
    // assistant + user(tool_result) 均已追加
    expect(messages.map(m => m.role)).toEqual(['assistant', 'user']);
  });

  it('只读并行分组：两个 readonly 工具的 started 都在 executeParallel 之前提交', async () => {
    const log: string[] = [];
    const { recovery } = makeLoggingRecovery(log);
    const executor = makeLoggingExecutor(log);
    const registry = {
      get: () => ({ readonly: true }),
    } as unknown as ToolRegistry;

    const result = await executeStep(makeStepInput({
      llm: makeToolUseLLM(TWO_TOOLS),
      executor,
      registry,
      recovery,
    }));

    expect(result.kind).toBe('continue');
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.executeParallel).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      'llmResponseCommitted',
      'toolStarted:tool_a',
      'toolStarted:tool_b',
      'executeParallel',
      'toolResultCommitted:tool_a',
      'toolResultCommitted:tool_b',
    ]);
  });
});
