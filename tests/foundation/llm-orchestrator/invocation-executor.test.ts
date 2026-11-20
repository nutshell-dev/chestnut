import { describe, expect, it, vi } from 'vitest';
import {
  LLMInvocationExecutor,
  type InvocationExecutorDeps,
} from '../../../src/foundation/llm-orchestrator/invocation-executor.js';
import { LLMProviderAdmission } from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import { LLMAllProvidersFailedError, classifyLLMError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMContextExceededError, LLMNetworkError } from '../../../src/foundation/llm-provider/errors.js';
import type { RecoveryFailureInput } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMOrchestratorConfig,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { llmProviderCall, llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
import { computeDynamicCallTimeoutMs } from '../../../src/foundation/llm-orchestrator/utils.js';
import { mockProviderFactory } from './provider-test-fixtures.js';
type LLMProvider = llmProviderCall.LLMProvider;
type LLMResponse = llmProviderCall.LLMResponse;
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;

/** Distinct positive fixture values keep primary/fallback config identity observable. */
const PRIMARY_TIMEOUT_FIXTURE_MS = 1_000;
const FALLBACK_TIMEOUT_FIXTURE_MS = 2_000;

const RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'fallback-ok' }],
  stop_reason: 'end_turn',
};

function provider(name: string, call: LLMProvider['call']): LLMProvider {
  return { name, model: `${name}-model`, call };
}

function fixture(primary: LLMProvider, fallbacks: LLMProvider[] = [], ids?: string[], maxAttempts = 1) {
  const events: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: event => { events.push(event); } };
  const config: LLMOrchestratorConfig = {
    primary: {
      providerId: primary.name, model: primary.model, apiFormat: 'anthropic',
      authentication: { kind: 'api_key' as const, value: 'primary', identity: 'primary' },
      defaults: { timeoutMs: PRIMARY_TIMEOUT_FIXTURE_MS },
    },
    fallbacks: fallbacks.map(adapter => ({
      providerId: adapter.name, model: adapter.model, apiFormat: 'anthropic',
      authentication: { kind: 'api_key' as const, value: adapter.name, identity: adapter.name },
      defaults: { timeoutMs: FALLBACK_TIMEOUT_FIXTURE_MS },
    })),
    maxAttempts,
    retryDelayMs: 0, // 禁用重试等待；failover 顺序由 mock adapter 同步决定。
    events: sink,
    providerFactory: mockProviderFactory,
  };
  const noteProviderSuccess = vi.fn();
  const noteFailure = vi.fn<(failures: readonly RecoveryFailureInput[]) => void>();
  const noteSuccess = vi.fn();
  const providerIds = ids ?? [primary.name, ...fallbacks.map(adapter => adapter.name)];
  const providerStates: never[] = [];
  const deps: InvocationExecutorDeps = {
    runtime: {
      primary: () => primary,
      fallbacks: () => fallbacks,
      descriptors: () => [config.primary, ...(config.fallbacks ?? [])].map(input => mockProviderFactory.create(input).descriptor),
      config: () => config,
      providerIds: () => providerIds,
      legacyProviderIds: () => providerIds,
      configGeneration: () => 0,
      prepareReload: () => { throw new Error('not used'); },
      commitReload: () => {},
      close: async () => {},
    },
    admission: new LLMProviderAdmission(),
    ledger: {
      noteAttemptStarted: vi.fn(),
      attemptContext: () => ({ probeOnly: false, allowBreakerProbe: false, attemptId: 'attempt-1' }),
      noteSuccess,
      snapshot: () => ({ instanceId: 'instance-test', revision: 0, recovery: {} as never, providers: providerStates }),
      noteProviderSuccess,
      noteFailure,
    },
    events: sink,
  };
  return {
    executor: new LLMInvocationExecutor(deps),
    events,
    noteProviderSuccess,
    noteFailure,
    noteSuccess,
  };
}

const admitted = { kind: 'admitted', invocationId: 'invocation-1', attemptId: 'attempt-1', factsAccepted: true } as const;

describe('InvocationExecutor failover and attempt audit', () => {
  it('fails over after the primary attempt and selects the fallback with ordered audit events', async () => {
    const calls: string[] = [];
    const primary = provider('primary', async () => {
      calls.push('primary');
      throw new Error('primary offline');
    });
    const fallback = provider('fallback', async () => {
      calls.push('fallback');
      return RESPONSE;
    });
    const f = fixture(primary, [fallback]);

    await expect(f.executor.call({ options: { messages: [] }, admission: admitted })).resolves.toBe(RESPONSE);

    expect(calls).toEqual(['primary', 'fallback']);
    expect(f.noteProviderSuccess).toHaveBeenCalledWith('fallback', expect.any(Number), true);
    expect(f.noteSuccess).toHaveBeenCalledWith('invocation-1', 'fallback');
    const relevant = f.events.filter(event =>
      event.type === 'provider_attempt_failed'
      || event.type === 'fallback_switched'
      || event.type === 'call_attempt_result'
      || event.type === 'call_selection');
    expect(relevant.map(event => event.type)).toEqual([
      'provider_attempt_failed',
      'call_attempt_result',
      'fallback_switched',
      'call_attempt_result',
      'call_selection',
    ]);
    expect(relevant[1]).toMatchObject({ outcome: 'failure', provider: 'primary', attemptIndex: 0 });
    expect(relevant[3]).toMatchObject({ outcome: 'success', provider: 'fallback', attemptIndex: 1 });
    expect(f.noteFailure).toHaveBeenCalledTimes(1);
  });
});

describe('InvocationExecutor timeout estimate ownership', () => {
  it('keeps retry and fallback estimates candidate-local without rewriting L1 request facts', async () => {
    const observations: InputMeasurementObservation[] = [];
    const primaryTimeouts: number[] = [];
    const fallbackTimeouts: number[] = [];
    const requestMeter = (providerName: string, tokens: number) => ({
      descriptor: {
        revision: `${providerName}-timeout-revision`, provider: providerName, model: `${providerName}-model`,
        api: 'test', contextWindow: 1_000_000, profile: 'test',
      },
      capability: { kind: 'complete_only' as const },
      measure: vi.fn(() => ({ kind: 'estimated' as const, tokens, method: 'deepseek-v41-text' as const, reason: 'test' })),
    });
    const primaryPrepare = vi.fn(async () => requestMeter('primary', 10));
    const fallbackPrepare = vi.fn(async () => requestMeter('fallback', 50_000));
    const artifactRef = (requestId: string) => ({
      artifactId: `input-artifact-${requestId}`, schemaVersion: 1 as const,
      status: 'unavailable' as const, hashAlgorithm: 'sha256' as const, reason: 'test',
    });
    const primary = provider('primary', async options => {
      const requestId = `primary-request-${primaryTimeouts.length + 1}`;
      primaryTimeouts.push(options.timeoutMs!);
      options.onInputMeasurement?.({
        kind: 'failed', requestId, provider: 'primary', model: 'primary-model', reason: 'offline',
        descriptorRevision: `revision-${requestId}`, inputSource: 'unlinked', artifactRef: artifactRef(requestId),
        measurement: { kind: 'estimated', tokens: 17, method: 'deepseek-v41-text', reason: 'request-local' },
      });
      throw new LLMNetworkError('primary', new Error('offline'));
    });
    primary.prepareInputMeter = primaryPrepare;
    const supplierResponse: LLMResponse = {
      ...RESPONSE,
      usage: { inputTokens: 29, outputTokens: 7, totalTokens: 36 },
    };
    const fallback = provider('fallback', async options => {
      const requestId = 'fallback-request-1';
      fallbackTimeouts.push(options.timeoutMs!);
      options.onInputMeasurement?.({
        kind: 'completed', requestId, provider: 'fallback', model: 'fallback-model',
        descriptorRevision: `revision-${requestId}`, inputSource: 'unlinked', artifactRef: artifactRef(requestId),
        measurement: { kind: 'estimated', tokens: 23, method: 'deepseek-v41-text', reason: 'request-local' },
        usage: { unCachedInputTokens: 29, outputTokens: 7, totalTokens: 36 },
        effectiveInputTokens: 29, normalizedUsageInputTokens: 29,
        measuredInputTokens: 23, deltaTokens: 6, reconciliation: 'mismatch',
      });
      return supplierResponse;
    });
    fallback.prepareInputMeter = fallbackPrepare;
    const f = fixture(primary, [fallback], undefined, 2);

    const result = await f.executor.call({
      options: { messages: [], onInputMeasurement: fact => observations.push(fact) },
      admission: admitted,
    });

    expect(result).toBe(supplierResponse);
    expect(result.usage).toEqual({ inputTokens: 29, outputTokens: 7, totalTokens: 36 });
    expect(primaryTimeouts).toEqual([
      computeDynamicCallTimeoutMs(PRIMARY_TIMEOUT_FIXTURE_MS, 10),
      computeDynamicCallTimeoutMs(PRIMARY_TIMEOUT_FIXTURE_MS, 10),
    ]);
    expect(fallbackTimeouts).toEqual([computeDynamicCallTimeoutMs(FALLBACK_TIMEOUT_FIXTURE_MS, 50_000)]);
    expect(primaryPrepare).toHaveBeenCalledTimes(1);
    expect(fallbackPrepare).toHaveBeenCalledTimes(1);
    expect(observations.map(fact => fact.requestId)).toEqual([
      'primary-request-1', 'primary-request-2', 'fallback-request-1',
    ]);
    expect(observations.every(fact =>
      fact.invocationId === admitted.invocationId
      && fact.attemptId === `${admitted.attemptId}:request:${fact.requestId}`)).toBe(true);
    expect(observations.map(fact => fact.artifactRef?.artifactId)).toEqual([
      'input-artifact-primary-request-1', 'input-artifact-primary-request-2', 'input-artifact-fallback-request-1',
    ]);
    expect(observations.map(fact => fact.measurement)).toEqual([
      { kind: 'estimated', tokens: 17, method: 'deepseek-v41-text', reason: 'request-local' },
      { kind: 'estimated', tokens: 17, method: 'deepseek-v41-text', reason: 'request-local' },
      { kind: 'estimated', tokens: 23, method: 'deepseek-v41-text', reason: 'request-local' },
    ]);
    const attemptResults = f.events.filter(event => event.type === 'call_attempt_result');
    expect(attemptResults[0]).toMatchObject({
      provider: 'primary', outcome: 'failure', requestIds: ['primary-request-1', 'primary-request-2'],
    });
    expect(attemptResults[1]).toMatchObject({
      provider: 'fallback', outcome: 'success', requestIds: ['fallback-request-1'],
    });
    expect(f.events.filter(event => event.type === 'input_measurement')).toHaveLength(3);
  });
});

describe('InvocationExecutor context candidate failover', () => {
  it('call context ends the primary without retry and selects the fallback', async () => {
    const calls: string[] = [];
    const primary = provider('primary', async () => {
      calls.push('primary');
      throw new LLMContextExceededError('primary', 413, 'too large');
    });
    const fallback = provider('fallback', async () => {
      calls.push('fallback');
      return RESPONSE;
    });
    const f = fixture(primary, [fallback], undefined, 3);

    await expect(f.executor.call({ options: { messages: [] }, admission: admitted })).resolves.toBe(RESPONSE);

    expect(calls).toEqual(['primary', 'fallback']);
    expect(f.events.filter(event => event.type === 'all_providers_context_exceeded')).toHaveLength(0);
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'call_attempt_result', provider: 'primary', outcome: 'failure', errorClass: 'context_exceeded',
    }));
  });

  it('continues past a small-window fallback context failure to the next fallback', async () => {
    const calls: string[] = [];
    const primary = provider('primary', async () => {
      calls.push('primary');
      throw new LLMNetworkError('primary', new Error('offline'));
    });
    const fallback1 = provider('fallback-1', async () => {
      calls.push('fallback-1');
      throw new LLMContextExceededError('fallback-1', 413, 'small window exceeded');
    });
    const fallback2 = provider('fallback-2', async () => {
      calls.push('fallback-2');
      return RESPONSE;
    });
    const f = fixture(primary, [fallback1, fallback2]);

    await expect(f.executor.call({ options: { messages: [] }, admission: admitted })).resolves.toBe(RESPONSE);

    expect(calls).toEqual(['primary', 'fallback-1', 'fallback-2']);
    const attempts = f.events.filter(event => event.type === 'call_attempt_result');
    expect(attempts.map(event => [event.provider, event.attemptIndex, event.outcome])).toEqual([
      ['primary', 0, 'failure'],
      ['fallback-1', 1, 'failure'],
      ['fallback-2', 2, 'success'],
    ]);
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'call_selection', outcome: 'selected', provider: 'fallback-2', attemptIndex: 2,
    }));
  });

  it('all-context call throws an aggregate with ordered typed evidence and no same-provider retries', async () => {
    const calls: string[] = [];
    const context = (name: string) => async () => {
      calls.push(name);
      throw new LLMContextExceededError(name, 413, `${name} too large`);
    };
    const f = fixture(provider('primary', context('primary')), [provider('fallback', context('fallback'))], undefined, 3);

    const caught = await f.executor.call({ options: { messages: [] }, admission: admitted })
      .then(() => undefined, error => error as LLMAllProvidersFailedError);

    expect(caught).toBeInstanceOf(LLMAllProvidersFailedError);
    if (!(caught instanceof LLMAllProvidersFailedError)) throw caught;
    expect(calls).toEqual(['primary', 'fallback']);
    expect(caught.failures.map(failure => failure.provider)).toEqual(['primary', 'fallback']);
    expect(caught.evidence.map(failure => failure.family)).toEqual(['context_exceeded', 'context_exceeded']);
    expect(classifyLLMError(caught)).toBe('context_exceeded');
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'all_providers_context_exceeded', totalAttempted: 2, skippedCount: 0,
    }));
  });

  it('mixed call failures retain context and transient evidence with existing classification priority', async () => {
    const primaryError = new LLMContextExceededError('primary', 413, 'too large');
    const fallbackError = new LLMNetworkError('fallback', new Error('offline'));
    const primary = provider('primary', async () => { throw primaryError; });
    const fallback = provider('fallback', async () => { throw fallbackError; });
    const f = fixture(primary, [fallback]);

    const caught = await f.executor.call({ options: { messages: [] }, admission: admitted })
      .then(() => undefined, error => error as LLMAllProvidersFailedError);

    expect(caught).toBeInstanceOf(LLMAllProvidersFailedError);
    if (!(caught instanceof LLMAllProvidersFailedError)) throw caught;
    expect(caught.failures.map(failure => failure.error)).toEqual([primaryError, fallbackError]);
    expect(caught.evidence.map(failure => failure.family)).toEqual(['context_exceeded', 'transient']);
    expect(classifyLLMError(caught)).toBe('transient');
    expect(f.events.filter(event => event.type === 'all_providers_context_exceeded')).toHaveLength(0);
  });

  it('stream handshake context fails over without retry or a spurious partial reset', async () => {
    let primaryCalls = 0;
    const primary = provider('primary', async () => RESPONSE);
    primary.stream = async function* () {
      primaryCalls++;
      throw new LLMContextExceededError('primary', 413, 'too large');
    };
    const fallback = provider('fallback', async () => RESPONSE);
    fallback.stream = async function* () {
      yield { type: 'text_delta', delta: 'fallback-ok' };
      yield { type: 'done' };
    };
    const f = fixture(primary, [fallback], undefined, 3);
    const chunks = [];

    for await (const chunk of f.executor.stream({ options: { messages: [] }, admission: admitted })) {
      chunks.push(chunk);
    }

    expect(primaryCalls).toBe(1);
    expect(chunks).toEqual([
      {
        type: 'provider_failed',
        provider: 'primary',
        model: 'primary-model',
        error: 'LLM context exceeded for primary (HTTP 413): too large',
      },
      { type: 'text_delta', delta: 'fallback-ok' },
      { type: 'done' },
    ]);
  });

  it('stream context-done resets partial output and continues the fallback', async () => {
    let primaryCalls = 0;
    const primary = provider('primary', async () => RESPONSE);
    primary.stream = async function* () {
      primaryCalls++;
      yield { type: 'text_delta', delta: 'partial' };
      yield { type: 'done', stopReason: 'model_context_window_exceeded' };
    };
    const fallback = provider('fallback', async () => RESPONSE);
    fallback.stream = async function* () {
      yield { type: 'text_delta', delta: 'fallback-ok' };
      yield { type: 'done' };
    };
    const f = fixture(primary, [fallback], undefined, 3);
    const chunks = [];

    for await (const chunk of f.executor.stream({ options: { messages: [] }, admission: admitted })) {
      chunks.push(chunk);
    }

    expect(primaryCalls).toBe(1);
    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'partial' },
      { type: 'reset', provider: 'primary' },
      { type: 'text_delta', delta: 'fallback-ok' },
      { type: 'done' },
    ]);
  });
});

describe('InvocationExecutor stream provider positions', () => {
  it('tries distinct adapters even when their provider identities are duplicated', async () => {
    const primary = provider('primary', async () => RESPONSE);
    primary.stream = async function* () {};
    const fallback = provider('fallback', async () => RESPONSE);
    fallback.stream = async function* () {
      yield { type: 'text_delta', delta: 'fallback-ok' };
      yield { type: 'done' };
    };
    const f = fixture(primary, [fallback], ['duplicate-id', 'duplicate-id']);
    const chunks = [];
    for await (const chunk of f.executor.stream({ options: { messages: [] }, admission: admitted })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(f.noteProviderSuccess).toHaveBeenCalledWith('duplicate-id', expect.any(Number), true);
    expect(f.noteSuccess).toHaveBeenCalledWith('invocation-1', 'duplicate-id');
  });
});

describe('InvocationExecutor stream cleanup', () => {
  it('closes the provider iterator and clears the current provider on consumer early return', async () => {
    let providerFinally = 0;
    const primary = provider('primary', async () => RESPONSE);
    primary.stream = async function* () {
      try {
        yield { type: 'text_delta', delta: 'partial' };
        yield { type: 'done' };
      } finally {
        providerFinally += 1;
      }
    };
    const f = fixture(primary);
    const stream = f.executor.stream({
      options: { messages: [], streamIdleTimeoutMs: 60_000 },
      admission: admitted,
    });

    expect((await stream.next()).value).toMatchObject({ type: 'text_delta', delta: 'partial' });
    expect(f.executor.getProviderInfo()).toMatchObject({ name: 'primary' });
    expect((await stream.return()).done).toBe(true);

    expect(providerFinally).toBe(1);
    expect(f.executor.getProviderInfo()).toMatchObject({ name: 'primary' });
    expect(f.noteProviderSuccess).not.toHaveBeenCalled();
    expect(f.noteSuccess).not.toHaveBeenCalled();
  });
});
