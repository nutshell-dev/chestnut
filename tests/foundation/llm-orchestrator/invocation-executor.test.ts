import { describe, expect, it, vi } from 'vitest';
import {
  LLMInvocationExecutor,
  type InvocationExecutorDeps,
} from '../../../src/foundation/llm-orchestrator/invocation-executor.js';
import { LLMProviderAdmission } from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import { classifyLLMError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type { RecoveryFailureInput } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';
import type {
  LLMEvent,
  LLMEventSink,
  LLMOrchestratorConfig,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { LLMProvider, LLMResponse } from '../../../src/foundation/llm-provider/index.js';

const RESPONSE: LLMResponse = {
  content: [{ type: 'text', text: 'fallback-ok' }],
  stop_reason: 'end_turn',
};

function provider(name: string, call: LLMProvider['call']): LLMProvider {
  return { name, model: `${name}-model`, call };
}

function fixture(primary: LLMProvider, fallbacks: LLMProvider[] = [], ids?: string[]) {
  const events: LLMEvent[] = [];
  const sink: LLMEventSink = { emit: event => { events.push(event); } };
  const config: LLMOrchestratorConfig = {
    primary: { name: primary.name, model: primary.model, apiFormat: 'anthropic', timeoutMs: 1_000 },
    fallbacks: fallbacks.map(adapter => ({ name: adapter.name, model: adapter.model, apiFormat: 'anthropic', timeoutMs: 2_000 })),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
  };
  let currentStreamingProvider: { name: string; model: string; isFallback: boolean } | null = null;
  const recordProviderSuccess = vi.fn();
  const recordRecoveryFailures = vi.fn<(failures: readonly RecoveryFailureInput[]) => void>();
  const noteSuccess = vi.fn();
  const deps: InvocationExecutorDeps = {
    runtime: {
      primary: () => primary,
      fallbacks: () => fallbacks,
      config: () => config,
      providerIds: () => ids ?? [primary.name, ...fallbacks.map(adapter => adapter.name)],
      providerStates: () => [],
      configGeneration: () => 0,
      instanceId: () => 'instance-test',
    },
    admission: new LLMProviderAdmission(),
    ledger: {
      noteAttemptStarted: vi.fn(),
      attemptContext: () => ({ probeOnly: false, allowBreakerProbe: false, attemptId: 'attempt-1' }),
      noteSuccess,
    },
    host: {
      isRecoveryBlocking: () => false,
      setCurrentStreamingProvider: value => { currentStreamingProvider = value; },
      recordProviderSuccess,
      recordRecoveryFailures,
      toRecoveryFailures: failures => failures.map(failure => ({
        providerId: failure.providerId ?? `unknown:${failure.provider}`,
        errorClass: classifyLLMError(failure.error),
        message: failure.error.message,
      })),
      noteFailureObserved: vi.fn(),
    },
    events: sink,
  };
  return {
    executor: new LLMInvocationExecutor(deps),
    events,
    recordProviderSuccess,
    recordRecoveryFailures,
    noteSuccess,
    getCurrentStreamingProvider: () => currentStreamingProvider,
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
    expect(f.recordProviderSuccess).toHaveBeenCalledWith(1, fallback, true, 0, true);
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
    expect(f.recordRecoveryFailures).toHaveBeenCalledTimes(1);
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
    expect(f.recordProviderSuccess).toHaveBeenCalledWith(1, fallback, true, 0, true);
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
    expect(f.getCurrentStreamingProvider()).toMatchObject({ name: 'primary' });
    expect((await stream.return()).done).toBe(true);

    expect(providerFinally).toBe(1);
    expect(f.getCurrentStreamingProvider()).toBeNull();
    expect(f.recordProviderSuccess).not.toHaveBeenCalled();
    expect(f.noteSuccess).not.toHaveBeenCalled();
  });
});
