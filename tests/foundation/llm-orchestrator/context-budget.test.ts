/**
 * Phase 1955 Step E：调用前输入预算与动态 timeout。
 *
 * 1. 纯函数边界：>= 70% warn、>= 80% exceeded；动态 timeout 随输入增长且封顶。
 * 2. 真实 orchestrator：小 context window 模型（4095）下 80% 输入不触达 provider，
 *    70% 输入照常调用并 emit 预警 + 使用动态 timeout。
 */
import { describe, it, expect } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  classifyContextBudget,
  computeDynamicCallTimeoutMs,
} from '../../../src/foundation/llm-orchestrator/utils.js';
import {
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_TOKENS_PER_SECOND,
} from '../../../src/foundation/llm-orchestrator/defaults.js';
import type { LLMEvent, LLMEventSink } from '../../../src/foundation/llm-orchestrator/index.js';
import type {
  ProviderAdapter,
  ProviderConfig,
  LLMCallOptions,
  LLMResponse,
} from '../../../src/foundation/llm-provider/index.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

/** openrouter 上真实 catalog 值为 4095 的小窗口模型（精确命中优先于启发式）。 */
const SMALL_WINDOW_MODEL = 'openai/gpt-3.5-turbo-0613';

function providerConfig(): ProviderConfig {
  return {
    name: 'openrouter',
    apiKey: 'key',
    model: SMALL_WINDOW_MODEL,
    temperature: 0,
    timeoutMs: 1_000,
    apiFormat: 'anthropic',
  };
}

function createOwner() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: (event) => { emitted.push(event); } };
  const received: LLMCallOptions[] = [];
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: 'openrouter',
    model: SMALL_WINDOW_MODEL,
    call: async (options) => {
      calls++;
      received.push(options as LLMCallOptions);
      return OK_RESPONSE;
    },
    stream: async function* () {
      calls++;
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const owner = createLLMOrchestrator({
    primary: providerConfig(),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    createProviderAdapter: () => adapter,
  });
  return { owner, emitted, received, calls: () => calls };
}

describe('Phase 1955 Step E: context budget classification', () => {
  it('70% warn / 80% exceeded 边界', () => {
    expect(classifyContextBudget(699, 1_000)).toBe('ok');
    expect(classifyContextBudget(700, 1_000)).toBe('warn');
    expect(classifyContextBudget(799, 1_000)).toBe('warn');
    expect(classifyContextBudget(800, 1_000)).toBe('exceeded');
  });

  it('动态 timeout 随输入增长且封顶 10min', () => {
    expect(computeDynamicCallTimeoutMs(60_000, 0)).toBe(60_000);
    expect(computeDynamicCallTimeoutMs(60_000, 50_000)).toBe(
      60_000 + (50_000 / LLM_TIMEOUT_TOKENS_PER_SECOND) * 1_000,
    );
    expect(computeDynamicCallTimeoutMs(60_000, 10_000_000)).toBe(LLM_TIMEOUT_MAX_MS);
  });
});

describe('Phase 1955 Step E: orchestrator preflight admission', () => {
  it('>= 80% 输入不触发 provider 调用，抛 typed context_exceeded', async () => {
    const { owner, emitted, calls } = createOwner();
    // ~4000 tokens > 4095 * 0.8（3276）；provider 必须零调用。
    const messages = [{ role: 'user' as const, content: 'word '.repeat(4_000) }];

    await expect(owner.call({ messages })).rejects.toMatchObject({
      code: 'LLM_CONTEXT_EXCEEDED',
    });
    expect(calls()).toBe(0);
    expect(emitted.some(e => e.type === 'context_exceeded_throwthrough')).toBe(true);
    await owner.close();
  });

  it('70%~80% 输入照常调用：emit 预警且使用动态 timeout', async () => {
    const { owner, emitted, received, calls } = createOwner();
    // ~3000 tokens ≈ 73% of 4095：高于 70% 阈值、低于 80% 硬上限。
    const messages = [{ role: 'user' as const, content: 'word '.repeat(3_000) }];

    await expect(owner.call({ messages })).resolves.toBe(OK_RESPONSE);
    expect(calls()).toBe(1);

    const warning = emitted.find(e => e.type === 'context_budget_warning');
    expect(warning).toBeDefined();
    if (warning?.type === 'context_budget_warning') {
      expect(warning.contextWindow).toBe(4_095);
      expect(warning.ratio).toBeGreaterThanOrEqual(0.7);
      expect(warning.ratio).toBeLessThan(0.8);
    }
    // 基础 timeout 1000ms + 3000 tokens 余量 → 明显高于固定 1000ms。
    expect(received[0].timeoutMs).toBeGreaterThan(5_000);
    await owner.close();
  });

  it('stream 路径同样在硬上限前拦截（0 chunk）', async () => {
    const { owner, calls } = createOwner();
    const messages = [{ role: 'user' as const, content: 'word '.repeat(4_000) }];

    await expect(async () => {
      for await (const _chunk of owner.stream({ messages })) {
        // no chunks expected
      }
    }).rejects.toMatchObject({ code: 'LLM_CONTEXT_EXCEEDED' });
    expect(calls()).toBe(0);
    await owner.close();
  });
});
