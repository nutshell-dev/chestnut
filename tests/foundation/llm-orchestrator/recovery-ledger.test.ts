import { describe, expect, it } from 'vitest';
import { LLMRecoveryControllerImpl } from '../../../src/foundation/llm-orchestrator/recovery-ledger.js';
import { LLMProviderAdmission } from '../../../src/foundation/llm-orchestrator/provider-admission.js';
import {
  createEmptyLLMInstanceState,
  type LLMInstanceStateV4,
} from '../../../src/foundation/llm-orchestrator/instance-state.js';
import type { LLMEvent } from '../../../src/foundation/llm-orchestrator/types.js';
import type { InstanceStateStore } from '../../../src/foundation/llm-orchestrator/instance-state-store.js';

function fixture(
  initial: LLMInstanceStateV4 = createEmptyLLMInstanceState('instance-a'),
  providerIds: readonly string[] = ['current'],
  legacyProviderIds: readonly string[] = ['legacy'],
) {
  void legacyProviderIds;
  let state = structuredClone(initial);
  const events: LLMEvent[] = [];
  const contexts: string[] = [];
  let failCommits = false;
  const store: InstanceStateStore = {
    load: () => state,
    snapshot: () => structuredClone({
      instanceId: state.instanceId,
      recovery: state.recovery,
      revision: state.revision,
      providers: state.providers,
    }),
    get revision() { return state.revision; },
    get state() { return state; },
    commit: (context, candidate) => {
      contexts.push(context);
      if (failCommits) return { kind: 'failed', error: new Error('commit failed') };
      state = {
        ...state,
        revision: state.revision + 1,
        recovery: candidate.recovery,
        providers: candidate.providers as LLMInstanceStateV4['providers'],
      };
      return { kind: 'ephemeral', revision: state.revision };
    },
  };
  const controller = new LLMRecoveryControllerImpl({
    store,
    providerIds,
    operationalIdentities: providerIds.map(providerId => `op-${providerId}`),
    admission: new LLMProviderAdmission(),
    now: () => 10_000,
    emit: event => { events.push(event); },
  });
  return {
    controller, events, contexts,
    read: () => state,
    failCommits: () => { failCommits = true; },
  };
}

describe('RecoveryLedger construction and admission', () => {
  it('keeps legacy recovery facts untouched while recovering V4 invocations', () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [{ providerId: 'current', operationalIdentity: 'op-current', status: 'waiting', retryAt: 40_000 }];
    initial.recovery.providers = [{
      providerId: 'legacy', errorClass: 'transient', at: '1970-01-01T00:00:01.000Z',
      consecutiveFailures: 1, detail: 'offline', blocking: true, retryAt: '1970-01-01T00:00:40.000Z',
    }];
    initial.recovery.invocations = [
      { invocationId: 'started', attemptId: 'attempt-started', started: true, requestKey: 'a', triggerKind: 'automatic' },
      { invocationId: 'pending', attemptId: 'attempt-pending', started: false, requestKey: 'b', triggerKind: 'automatic' },
    ];

    const f = fixture(initial);
    expect(f.contexts).toEqual(['constructor']);
    expect(f.read().providers).toEqual([{
      providerId: 'current', operationalIdentity: 'op-current', status: 'waiting', retryAt: 40_000,
    }]);
    expect(f.read().recovery.providers[0]).toMatchObject({ providerId: 'legacy' });
    expect(f.read().recovery.providers[0]).not.toHaveProperty('identityMigrationPending');
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
  it('begin persists facts without invoking legacy release or rewriting old provider IDs', async () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [{ providerId: 'current', operationalIdentity: 'op-current', status: 'available' }];
    initial.recovery.providers = [
      {
        providerId: 'retired', errorClass: 'permanent', at: '1970-01-01T00:00:01.000Z',
        consecutiveFailures: 3, detail: 'retired', blocking: true,
      },
      {
        providerId: 'current', errorClass: 'transient', at: '1970-01-01T00:00:02.000Z',
        consecutiveFailures: 2, detail: 'current failure', blocking: true,
      },
    ];
    const before = structuredClone(initial);
    const f = fixture(initial);

    const admission = await f.controller.begin({
      requestKey: 'request-current-entry',
      facts: { interventionIds: [], configurationRevision: 'config-current-entry' },
    });

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(f.read().revision).toBe(1);
    expect(f.read().providers).toEqual(before.providers);
    expect(f.read().recovery.providers).toEqual([
      expect.objectContaining({ providerId: 'retired', errorClass: 'permanent', blocking: true }),
      expect.objectContaining({ providerId: 'current', errorClass: 'transient', blocking: true }),
    ]);
    expect(f.read().recovery.acceptedConfigRevisions).toEqual(['config-current-entry']);
    expect(f.read().recovery.acceptedFactBatches).toEqual([{
      revision: 1, interventionIds: [], configurationRevision: 'config-current-entry',
      attemptId: admission.attemptId, invocationId: admission.invocationId,
    }]);
    expect(f.contexts).toEqual(['begin']);
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

  it('reports ready with failure evidence when another current provider remains available', () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [
      { providerId: 'primary', operationalIdentity: 'op-primary', status: 'available' },
      { providerId: 'fallback', operationalIdentity: 'op-fallback', status: 'available' },
    ];
    const f = fixture(initial, ['primary', 'fallback'], ['legacy-primary', 'legacy-fallback']);

    f.controller.noteFailure([{
      providerId: 'primary', errorClass: 'transient', message: 'primary offline',
      occurredAtMs: 10_000, invocationId: 'invocation-a', attemptId: 'attempt-a',
    }]);

    expect(f.events).toEqual([expect.objectContaining({
      type: 'recovery_scheduled', revision: f.read().revision,
      scheduleKind: 'ready', resumeAt: '',
      invocationId: 'invocation-a', attemptId: 'attempt-a',
      errorClass: 'transient', failureCount: 1,
    })]);
    expect(f.read().recovery.failures[0]).toMatchObject({
      providerId: 'primary', message: 'primary offline', invocationId: 'invocation-a',
    });
  });

  it('reports ready when fallback fails but primary remains available', () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [
      { providerId: 'primary', operationalIdentity: 'op-primary', status: 'available' },
      { providerId: 'fallback', operationalIdentity: 'op-fallback', status: 'available' },
    ];
    const f = fixture(initial, ['primary', 'fallback'], ['legacy-primary', 'legacy-fallback']);

    f.controller.noteFailure([{
      providerId: 'fallback', errorClass: 'transient', message: 'fallback offline',
      occurredAtMs: 10_000, invocationId: 'invocation-fallback', attemptId: 'attempt-fallback',
    }]);

    expect(f.events).toEqual([expect.objectContaining({
      type: 'recovery_scheduled', revision: f.read().revision,
      scheduleKind: 'ready', resumeAt: '',
      invocationId: 'invocation-fallback', attemptId: 'attempt-fallback',
      errorClass: 'transient', failureCount: 1,
    })]);
    expect(f.read().providers).toEqual([
      expect.objectContaining({ providerId: 'primary', operationalIdentity: 'op-primary', status: 'available' }),
      expect.objectContaining({ providerId: 'fallback', status: 'waiting' }),
    ]);
    expect(f.read().recovery.failures[0]).toMatchObject({
      providerId: 'fallback', message: 'fallback offline', invocationId: 'invocation-fallback',
    });
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
    }])).toThrow('persistence failed during noteFailure');
    expect(f.read()).toEqual(before);
    expect(f.events).toEqual([expect.objectContaining({
      type: 'recovery_state_write_failed', context: 'noteFailure',
      reason: expect.stringContaining('LLM instance state persistence failed during noteFailure'),
    })]);
  });
});


describe('RecoveryLedger provider facts', () => {
  it('commits business selection separately from probe health and exposes a detached snapshot', () => {
    const f = fixture();
    const commits: string[] = [];
    f.controller.subscribeCommits(context => commits.push(context));

    f.controller.noteProviderSuccess('current', 20_000, true);
    expect(f.controller.snapshot()).toMatchObject({
      instanceId: 'instance-a', revision: 1,
      providers: [{ providerId: 'current', status: 'available', lastSuccessAt: 20_000 }],
    });
    const snapshot = f.controller.snapshot();
    (snapshot.providers[0] as { lastSuccessAt?: number }).lastSuccessAt = 1;
    expect(f.controller.snapshot().providers[0]?.lastSuccessAt).toBe(20_000);

    f.controller.noteProviderSuccess('current', 30_000, false);
    expect(f.controller.snapshot().providers[0]).toMatchObject({
      lastSuccessAt: 20_000, cacheValidUntil: 320_000, consecutiveFailures: 0,
    });
    expect(commits).toEqual(['provider_success']);
  });

  it('persists reload filtering and preserves unchanged health and selection', () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [
      { providerId: 'current', operationalIdentity: 'op-current', status: 'waiting', retryAt: 50_000, lastSuccessAt: 1, cacheValidUntil: 2 },
      { providerId: 'removed', operationalIdentity: 'op-removed', status: 'available', lastSuccessAt: 3, cacheValidUntil: 4 },
    ];
    const f = fixture(initial);
    f.controller.reloadProviderIdentities(['current'], ['op-current']);
    expect(f.controller.snapshot().providers).toEqual([{
      providerId: 'current', operationalIdentity: 'op-current', status: 'waiting', retryAt: 50_000,
      lastSuccessAt: 1, cacheValidUntil: 2,
    }]);
    expect(f.contexts).toEqual(['reload_config']);
  });

  it('clears only the entry whose execution version changed', () => {
    const initial = createEmptyLLMInstanceState('instance-a');
    initial.providers = [
      { providerId: 'current', operationalIdentity: 'op-current', status: 'waiting', retryAt: 50_000, lastSuccessAt: 1, cacheValidUntil: 2 },
      { providerId: 'fallback', operationalIdentity: 'op-fallback', status: 'waiting', retryAt: 60_000, consecutiveFailures: 2 },
    ];
    const f = fixture(initial, ['current', 'fallback']);
    f.controller.reloadProviderIdentities(['current', 'fallback'], ['op-new', 'op-fallback']);
    expect(f.controller.snapshot().providers).toEqual([
      {
        providerId: 'current', operationalIdentity: 'op-new', status: 'available',
        previousOperationalIdentity: 'op-current', operationalChangeReason: 'operational_identity_changed',
      },
      { providerId: 'fallback', operationalIdentity: 'op-fallback', status: 'waiting', retryAt: 60_000, consecutiveFailures: 2 },
    ]);
  });
});
