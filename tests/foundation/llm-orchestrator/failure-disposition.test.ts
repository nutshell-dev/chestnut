/**
 * Phase 1944 Step B：LLM 失败处置事实（LLMFailureDisposition）owner 边界测试。
 *
 * 断言对象：
 * - LLMOrchestratorImpl.getFailureDisposition 把既有 classifyLLMError 结论映射为
 *   跨边界最小 union（provider_recovery_scheduled / context_exceeded / abort / unknown）；
 * - 聚合错误（LLMAllProvidersFailedError）按 nested 分类归派；
 * - owner 直接提供统一结论，不依赖 session/scoped 视图；
 * - 只读无副作用：查询不触发 retry 调度、不改变 provider 状态。
 */
import { describe, it, expect } from 'vitest';
import { createLLMOrchestrator } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLMAllProvidersFailedError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type { LLMEventSink, LLMResponse } from '../../../src/foundation/llm-orchestrator/index.js';
import type { ProviderAdapter, ProviderConfig } from '../../../src/foundation/llm-provider/index.js';
import {
  LLMAuthError,
  LLMContextExceededError,
  LLMError,
  LLMNetworkError,
  LLMOutputBudgetExceededError,
  LLMRateLimitError,
  LLMQuotaError,
} from '../../../src/foundation/llm-provider/errors.js';

const OK_RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
};

function providerConfig(name: string): ProviderConfig {
  return {
    name,
    apiKey: `key-${name}`,
    model: `model-${name}`,
    temperature: 0,
    timeoutMs: 1_000,
    apiFormat: 'anthropic',
  };
}

function makeAdapter(name: string): ProviderAdapter {
  return {
    name,
    model: `model-${name}`,
    call: async () => OK_RESPONSE,
    stream: async function* () { throw new Error('stream not enabled in this test'); },
  };
}

function makeOrchestrator() {
  const events: LLMEventSink = { emit: () => {} };
  const orchestrator = createLLMOrchestrator({
      lifecycle: { mode: 'ephemeral' },
    primary: providerConfig('primary'),
    maxAttempts: 1,
    retryDelayMs: 1,
    events,
    createProviderAdapter: (config) => makeAdapter(config.name),
  });
  return { orchestrator, events };
}

describe('phase 1944 Step B: LLMOrchestrator.getFailureDisposition', () => {
  it('transient / rate_limit / quota / permanent 类失败 → provider_recovery_scheduled', () => {
    const { orchestrator } = makeOrchestrator();

    expect(orchestrator.getFailureDisposition(new LLMNetworkError('p', new Error('ECONNRESET')))).toBe('provider_recovery_scheduled');
    expect(orchestrator.getFailureDisposition(new LLMRateLimitError('p'))).toBe('provider_recovery_scheduled');
    expect(orchestrator.getFailureDisposition(new LLMQuotaError('p', 'quota exceeded'))).toBe('provider_recovery_scheduled');
    expect(orchestrator.getFailureDisposition(new LLMAuthError('p', 401))).toBe('provider_recovery_scheduled');
    expect(orchestrator.getFailureDisposition(new LLMError('base llm error'))).toBe('provider_recovery_scheduled');
  });

  it('聚合错误按 nested 分类归派（transient 优先 / 全 permanent）', () => {
    const { orchestrator } = makeOrchestrator();

    const transientAggregate = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new LLMNetworkError('p1', new Error('down')) },
      { provider: 'p2', error: new LLMAuthError('p2', 401) },
    ]);
    expect(orchestrator.getFailureDisposition(transientAggregate)).toBe('provider_recovery_scheduled');

    const permanentAggregate = new LLMAllProvidersFailedError([
      { provider: 'p1', error: new LLMAuthError('p1', 401) },
      { provider: 'p2', error: new LLMAuthError('p2', 403) },
    ]);
    expect(orchestrator.getFailureDisposition(permanentAggregate)).toBe('provider_recovery_scheduled');
  });

  it('context_exceeded / abort / unknown 各自归类，不误标 provider recovery', () => {
    const { orchestrator } = makeOrchestrator();

    expect(orchestrator.getFailureDisposition(new LLMContextExceededError('p', 400, 'context length exceeded')))
      .toBe('context_exceeded');
    expect(orchestrator.getFailureDisposition(new LLMOutputBudgetExceededError('p', 200_000, 190_000, 20_000, 'output budget exceeded')))
      .toBe('context_exceeded');

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(orchestrator.getFailureDisposition(abort)).toBe('abort');

    expect(orchestrator.getFailureDisposition(new Error('plain crash'))).toBe('unknown');
    expect(orchestrator.getFailureDisposition('string failure')).toBe('unknown');
    expect(orchestrator.getFailureDisposition(undefined)).toBe('unknown');
  });

  it('owner 直接提供统一失败处置结论（无 session/scoped 视图）', () => {
    const { orchestrator } = makeOrchestrator();

    const err = new LLMNetworkError('p', new Error('offline'));
    expect(orchestrator.getFailureDisposition(err)).toBe('provider_recovery_scheduled');
    expect(orchestrator.getFailureDisposition(new Error('nope'))).toBe('unknown');
  });

  it('查询只读：不触发 retry/状态变化，provider 信息不变', () => {
    const { orchestrator } = makeOrchestrator();
    const before = orchestrator.getProviderInfo();

    orchestrator.getFailureDisposition(new LLMRateLimitError('p'));
    orchestrator.getFailureDisposition(new LLMAuthError('p', 401));

    expect(orchestrator.getProviderInfo()).toEqual(before);
  });
});
