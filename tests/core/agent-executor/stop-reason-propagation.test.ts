/**
 * ReactResult.stopReason propagation — phase 1483 + phase 324 (review-2026-06-13 C6)
 *
 * 守护：loop.mapStopReason 把 step-executor 的 FinalStopReason 正确投射到 ReactResult.stopReason，
 *
 * - phase 1483: 'content_filter' 字面单独保留（不再折叠为 'unknown'）— audit-2026-05-30 finding #3 修复
 * - phase 324 C6: 'refusal' / 'safety' / 'stop_sequence' / 新 SDK 值在 step-executor 不再
 *   折叠为 'content_filter'、改返 'unknown'。content_filter 桶仅当 API 真返 'content_filter' 时占。
 */

import { describe, it, expect, vi } from 'vitest';
import { runReact } from '../../../src/core/agent-executor/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';
import type { IToolExecutor } from '../../../src/foundation/tools/executor.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function makeLLMWithStopReason(stopReason: string): LLMOrchestrator {
  async function* stream(): AsyncIterableIterator<unknown> {
    yield { type: 'text_delta', delta: 'hi' };
    yield { type: 'done', stopReason };
  }
  return {
    call: vi.fn(async () => ({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
    } satisfies LLMResponse)),
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

async function runWithStopReason(stopReason: string): Promise<string> {
  const result = await runReact({
    messages: [],
    systemPrompt: '',
    llm: makeLLMWithStopReason(stopReason),
    tools: [],
    executor: makeNoopExecutor(),
    ctx: makeExecContext(),
    onUnparseableToolUse: () => {},
  });
  return result.stopReason;
}

describe('ReactResult.stopReason propagation (phase 1483 + phase 324 C6 桶分立)', () => {
  it('phase 324 C6: LLM unrecognized stop_reason (refusal) → step-executor 返 unknown → ReactResult 保留 unknown', async () => {
    // phase 324 C6 修前：step-executor 把任何 unrecognized stop_reason 折叠为 'content_filter'；
    // 修后：未识别值返 'unknown'，content_filter 桶仅留给 API 真返 'content_filter' 时占。
    expect(await runWithStopReason('refusal')).toBe('unknown');
  });

  it('phase 1483: API 真返 content_filter → 保留 content_filter（不折叠 unknown）', async () => {
    expect(await runWithStopReason('content_filter')).toBe('content_filter');
  });

  it('end_turn → end_turn', async () => {
    expect(await runWithStopReason('end_turn')).toBe('end_turn');
  });

  it('stop → end_turn（向后兼容 shim）', async () => {
    expect(await runWithStopReason('stop')).toBe('end_turn');
  });
});
