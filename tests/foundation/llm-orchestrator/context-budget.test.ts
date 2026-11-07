/**
 * Phase 1969: L2b 不再做调用前 context budget admission。
 *
 * 保留：
 * - `estimatePromptTokens` 仅用于动态 timeout；
 * - 真实 provider `LLMContextExceededError` → `context_exceeded_throwthrough` 原样上抛。
 *
 * 删除：
 * - >=80% 预检拦截、70% warning、classifyContextBudget 边界。
 */
import { describe, it, expect } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  computeDynamicCallTimeoutMs,
  estimatePromptTokens,
} from '../../../src/foundation/llm-orchestrator/utils.js';
import {
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_TOKENS_PER_SECOND,
} from '../../../src/foundation/llm-orchestrator/defaults.js';
import { isContextExceededError, type LLMEvent, type LLMEventSink } from '../../../src/foundation/llm-orchestrator/index.js';
import {
  LLMContextExceededError,
  type ProviderAdapter,
  type ProviderConfig,
  type LLMCallOptions,
  type LLMResponse,
} from '../../../src/foundation/llm-provider/index.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

/** openrouter 上真实 catalog 值为 4095 的小窗口模型（精确命中优先于启发式）。 */
const SMALL_WINDOW_MODEL = 'openai/gpt-3.5-turbo-0613';
const SMALL_WINDOW = 4_095;

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

function createOwner(opts: { callError?: Error; streamError?: Error } = {}) {
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
      if (opts.callError) throw opts.callError;
      return OK_RESPONSE;
    },
    stream: async function* () {
      calls++;
      if (opts.streamError) throw opts.streamError;
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
    primary: providerConfig(),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
    createProviderAdapter: () => adapter,
  });
  return { owner, emitted, received, calls: () => calls };
}

/** ~4000 tokens：旧预检会以 >80% × 4095 拦截。 */
function overFormerHardLimitMessages() {
  return [{ role: 'user' as const, content: 'word '.repeat(4_000) }];
}

describe('Phase 1969: no preflight admission', () => {
  it('动态 timeout 仍随输入增长且封顶 10min（estimatePromptTokens 保留）', () => {
    expect(computeDynamicCallTimeoutMs(60_000, 0)).toBe(60_000);
    expect(computeDynamicCallTimeoutMs(60_000, 50_000)).toBe(
      60_000 + (50_000 / LLM_TIMEOUT_TOKENS_PER_SECOND) * 1_000,
    );
    expect(computeDynamicCallTimeoutMs(60_000, 10_000_000)).toBe(LLM_TIMEOUT_MAX_MS);
  });

  it('>=80% 输入仍到达 provider（call），无 context_budget_warning', async () => {
    const { owner, emitted, received, calls } = createOwner();
    const options = { messages: overFormerHardLimitMessages() };
    expect(estimatePromptTokens(options)).toBeGreaterThan(SMALL_WINDOW * 0.8);

    await expect(owner.call(options)).resolves.toBe(OK_RESPONSE);
    expect(calls()).toBe(1);
    expect(emitted.map(e => e.type)).not.toContain('context_budget_warning');
    // 动态 timeout 仍生效（base 1000ms + token 余量）。
    expect(received[0].timeoutMs).toBeGreaterThan(5_000);
    await owner.close();
  });

  it('>=80% 输入仍到达 provider（stream），无 context_budget_warning', async () => {
    const { owner, emitted, calls } = createOwner();
    const options = { messages: overFormerHardLimitMessages() };
    expect(estimatePromptTokens(options)).toBeGreaterThan(SMALL_WINDOW * 0.8);

    const chunks: string[] = [];
    for await (const chunk of owner.stream(options)) {
      if (chunk.type === 'text_delta') chunks.push(chunk.delta);
    }
    expect(chunks.join('')).toBe('ok');
    expect(calls()).toBe(1);
    expect(emitted.map(e => e.type)).not.toContain('context_budget_warning');
    await owner.close();
  });

  it('真实 provider context_exceeded 保留 typed cause（不 retry、不伪造成功）', async () => {
    const providerError = new LLMContextExceededError('openrouter', 413, 'request too large');
    const { owner, emitted, calls } = createOwner({ callError: providerError });

    let caught: unknown;
    try {
      await owner.call({ messages: overFormerHardLimitMessages() });
    } catch (err) {
      caught = err;
    }
    expect(isContextExceededError(caught)).toBe(true);
    expect(caught).toBe(providerError);
    expect(calls()).toBe(1);
    expect(emitted.filter(e => e.type === 'context_exceeded_throwthrough')).toHaveLength(1);
    expect(emitted.map(e => e.type)).not.toContain('context_budget_warning');
    await owner.close();
  });

  it('多 provider primary typed context 原样上抛且不调用 fallback', async () => {
    const providerError = new LLMContextExceededError('primary', 413, 'request too large');
    let fallbackCalls = 0;
    const primary: ProviderAdapter = {
      name: 'primary', model: SMALL_WINDOW_MODEL,
      async call() { throw providerError; },
    };
    const fallback: ProviderAdapter = {
      name: 'fallback', model: SMALL_WINDOW_MODEL,
      async call() { fallbackCalls++; return OK_RESPONSE; },
    };
    const emitted: LLMEvent[] = [];
    const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
      primary: { ...providerConfig(), name: 'primary' },
      fallbacks: [{ ...providerConfig(), name: 'fallback' }],
      maxAttempts: 1, retryDelayMs: 0,
      events: { emit: event => { emitted.push(event); } },
      createProviderAdapter: config => config.name === 'fallback' ? fallback : primary,
    });

    let caught: unknown;
    try { await owner.call({ messages: [] }); } catch (error) { caught = error; }
    expect(caught).toBe(providerError);
    expect(fallbackCalls).toBe(0);
    expect(emitted.filter(e => e.type === 'context_exceeded_throwthrough')).toHaveLength(1);
    await owner.close();
  });

  it('sticky 与后续 fallback catch 均不吞 typed context', async () => {
    const stickyError = new LLMContextExceededError('fallback', 413, 'sticky too large');
    const fallbackError = new LLMContextExceededError('fallback', 413, 'fallback too large');
    for (const mode of ['sticky', 'fallback'] as const) {
      const contextError = mode === 'sticky' ? stickyError : fallbackError;
      let primaryCalls = 0;
      const primary: ProviderAdapter = {
        name: 'primary', model: SMALL_WINDOW_MODEL,
        async call() {
          primaryCalls++;
          if (mode === 'fallback') throw new Error('ordinary primary failure');
          return OK_RESPONSE;
        },
      };
      const fallback: ProviderAdapter = {
        name: 'fallback', model: SMALL_WINDOW_MODEL,
        async call() { throw contextError; },
      };
      const owner = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
        primary: { ...providerConfig(), name: 'primary' },
        fallbacks: [{ ...providerConfig(), name: 'fallback' }],
        maxAttempts: 1, retryDelayMs: 0,
        events: { emit: () => {} },
        createProviderAdapter: config => config.name === 'fallback' ? fallback : primary,
      });
      if (mode === 'sticky') {
        const now = Date.now();
        const [primaryId, fallbackId] = owner.getProviderIdentities();
        (owner as any).providerStates = [
          {
            providerId: primaryId,
            status: 'waiting',
            retryAt: now + 60_000,
            lastError: { class: 'transient', at: now, message: 'primary unavailable' },
            consecutiveFailures: 1,
          },
          {
            providerId: fallbackId,
            status: 'available',
            lastSuccessAt: now,
            cacheValidUntil: now + 300_000,
            consecutiveFailures: 0,
          },
        ];
      }

      let caught: unknown;
      try { await owner.call({ messages: [] }); } catch (error) { caught = error; }
      expect(caught).toBe(contextError);
      expect(primaryCalls).toBe(mode === 'sticky' ? 0 : 1);
      await owner.close();
    }
  });
});
