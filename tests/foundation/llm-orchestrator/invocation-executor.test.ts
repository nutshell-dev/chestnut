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
import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
import { mockProviderFactory } from './provider-test-fixtures.js';
type LLMProvider = llmProviderCall.LLMProvider;
type LLMResponse = llmProviderCall.LLMResponse;

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
