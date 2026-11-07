import { describe, expect, it } from 'vitest';
import { LLMRecoveryControllerImpl } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';
import { LLMProviderAdmission } from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import {
  createEmptyLLMInstanceState,
  type LLMInstanceStateV3,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';

function fixture(initial: LLMInstanceStateV3 = createEmptyLLMInstanceState('instance-a')) {
  let state = structuredClone(initial);
  const events: LLMEvent[] = [];
  const contexts: string[] = [];
  let failCommits = false;
  const controller = new LLMRecoveryControllerImpl({
    instanceId: state.instanceId,
    providerIds: ['current'],
    legacyProviderIds: ['legacy'],
    admission: new LLMProviderAdmission(),
    now: () => 10_000,
    read: () => ({ recovery: state.recovery, revision: state.revision, providers: state.providers }),
    emit: event => { events.push(event); },
    commit: (recovery, context, providers) => {
      contexts.push(context);
      if (failCommits) throw new Error('commit failed');
      state = {
        ...state,
        revision: state.revision + 1,
        recovery,
        providers: [...(providers ?? state.providers)],
      };
      return state.revision;
    },
  });
  return {
    controller, events, contexts,
    read: () => state,
    failCommits: () => { failCommits = true; },
  };
}

describe('RecoveryLedger construction and admission', () => {
  it('commits identity migration before restart recovery and retains unknown-result evidence', () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [{ providerId: 'legacy', status: 'waiting', retryAt: 40_000 }];
    initial.recovery.providers = [{
      providerId: 'legacy', errorClass: 'transient', at: '1970-01-01T00:00:01.000Z',
      consecutiveFailures: 1, detail: 'offline', blocking: true, retryAt: '1970-01-01T00:00:40.000Z',
    }];
    initial.recovery.invocations = [
      { invocationId: 'started', attemptId: 'attempt-started', started: true, requestKey: 'a', triggerKind: 'automatic' },
      { invocationId: 'pending', attemptId: 'attempt-pending', started: false, requestKey: 'b', triggerKind: 'automatic' },
    ];

    const f = fixture(initial);
    expect(f.contexts).toEqual(['migration', 'constructor']);
    expect(f.read().providers).toEqual([{ providerId: 'current', status: 'waiting', retryAt: 40_000 }]);
    expect(f.read().recovery.providers[0]).toMatchObject({ providerId: 'current', identityMigrationPending: true });
    expect(f.read().recovery.invocations).toEqual([{
      invocationId: 'pending', attemptId: 'attempt-pending', started: false, requestKey: 'b',
      triggerKind: 'automatic', resumedFromRestart: true,
    }]);
    expect(f.read().recovery.failures).toEqual([expect.objectContaining({
      providerId: 'unknown', invocationId: 'started', attemptId: 'attempt-started', errorClass: 'unknown',
    })]);
  });

  it('records accepted fact batches and emits facts before admission', async () => {
    const f = fixture();
    const admission = await f.controller.begin({
      requestKey: 'request-a',
      facts: { interventionIds: ['intervention-a'], configurationRevision: 'config-a', startupId: 'startup-a' },
    });
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(f.read().recovery.invocations[0]).toMatchObject({
      invocationId: admission.invocationId,
      attemptId: admission.attemptId,
      interventionIds: ['intervention-a'],
      configurationRevision: 'config-a', startupId: 'startup-a',
    });
    expect(f.read().recovery.acceptedFactBatches).toEqual([{
      revision: 1, interventionIds: ['intervention-a'], configurationRevision: 'config-a', startupId: 'startup-a',
      attemptId: admission.attemptId, invocationId: admission.invocationId,
    }]);
    expect(f.events.map(event => event.type)).toEqual(['recovery_facts_accepted', 'recovery_attempt_admitted']);
    expect(f.events[1]).toMatchObject({ revision: 1, invocationId: admission.invocationId, attemptId: admission.attemptId });
  });

  it('resumes the original unstarted invocation after restart', async () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.recovery.invocations = [{
      invocationId: 'invocation-a', attemptId: 'attempt-a', started: false,
      requestKey: 'request-a', triggerKind: 'automatic',
    }];
    const f = fixture(initial);
    expect(f.contexts).toEqual(['constructor']);
    const admission = await f.controller.begin({ requestKey: 'request-a', facts: { interventionIds: [] } });
    expect(admission).toEqual({
      kind: 'admitted', invocationId: 'invocation-a', attemptId: 'attempt-a', factsAccepted: true,
    });
    expect(f.read().recovery.invocations[0]?.resumedFromRestart).toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ type: 'recovery_attempt_admitted', trigger: 'resumed' });
  });
});

describe('RecoveryLedger failure evidence', () => {
  it('uses ProviderAdmission retryAt and preserves invocation evidence and event order', () => {
    const f = fixture();
    f.controller.noteFailure([{
      providerId: 'current', errorClass: 'rate_limit', message: 'limited', providerLabel: 'Primary',
      occurredAtMs: 10_000, retryAfterSec: 45,
      invocationId: 'invocation-a', attemptId: 'attempt-a', attemptIndex: 2, configRevision: 3,
    }]);
    expect(f.read().providers[0]).toMatchObject({
      providerId: 'current', status: 'waiting', retryAt: 55_000, consecutiveFailures: 1,
      lastError: { class: 'rate_limit', at: 10_000, retryAfterSec: 45 },
    });
    expect(f.read().recovery.failures).toEqual([{
      at: '1970-01-01T00:00:10.000Z', providerId: 'current', errorClass: 'rate_limit', message: 'limited',
      providerLabel: 'Primary', invocationId: 'invocation-a', attemptId: 'attempt-a', attemptIndex: 2, configRevision: 3,
    }]);
    expect(f.events).toEqual([expect.objectContaining({
      type: 'recovery_scheduled', revision: 1, scheduleKind: 'at', resumeAt: '1970-01-01T00:00:55.000Z',
      invocationId: 'invocation-a', attemptId: 'attempt-a', failureCount: 1,
    })]);
  });

  it('ignores local skips and reports commit failure without publishing the candidate', () => {
    const f = fixture();
    const before = f.read();
    f.controller.noteFailure([
      { providerId: 'current', errorClass: 'transient', message: 'skip', localSkip: true },
      { providerId: 'current', errorClass: 'abort', message: 'abort' },
    ]);
    expect(f.read()).toEqual(before);
    expect(f.events).toEqual([]);

    f.failCommits();
    expect(() => f.controller.noteFailure([{
      providerId: 'current', errorClass: 'transient', message: 'offline', occurredAtMs: 10_000,
    }])).toThrow('commit failed');
    expect(f.read()).toEqual(before);
    expect(f.events).toEqual([expect.objectContaining({
      type: 'recovery_state_write_failed', context: 'noteFailure', reason: 'commit failed',
    })]);
  });
});
