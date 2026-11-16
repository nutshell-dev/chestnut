import { describe, expect, it } from 'vitest';
import { InvocationSelectionLedger } from '../../../src/foundation/llm-orchestrator/index.js';

const INVOCATION = 'inv-1';
const RECOVERY_ATTEMPT = 'recovery-1';

function started(): Record<string, unknown> {
  return {
    type: 'call_invocation_started', schemaVersion: 1,
    invocationId: INVOCATION, attemptId: RECOVERY_ATTEMPT,
    orchestratorInstance: 'test', kind: 'call', configRevision: 1, candidates: [],
  };
}

function attempt(
  providerAttemptId: string,
  provider: string,
  outcome: 'started' | 'running' | 'success' | 'failure' | 'skipped' | 'discarded' | 'cancelled',
  attemptIndex: number,
  requestIds: string[] = [`req-${providerAttemptId}`],
): Record<string, unknown> {
  return {
    type: 'call_attempt_result', schemaVersion: 1,
    invocationId: INVOCATION, attemptId: RECOVERY_ATTEMPT,
    providerAttemptId, attemptIndex, provider, providerId: `id-${provider}`,
    outcome, requestIds,
  };
}

function selected(providerAttemptId: string, provider: string, attemptIndex: number): Record<string, unknown> {
  return {
    type: 'call_selection', schemaVersion: 1,
    invocationId: INVOCATION, attemptId: RECOVERY_ATTEMPT,
    providerAttemptId, attemptIndex, provider, outcome: 'selected',
  };
}

function exhausted(): Record<string, unknown> {
  return {
    type: 'call_selection', schemaVersion: 1,
    invocationId: INVOCATION, attemptId: RECOVERY_ATTEMPT, outcome: 'exhausted',
  };
}

function state(events: Iterable<unknown>) {
  return InvocationSelectionLedger.replay(events);
}

describe('InvocationSelectionLedger', () => {
  it('replays a successful retry with every request id linked to the selected candidate', () => {
    const replay = state([
      started(),
      attempt('retry', 'primary', 'success', 0, ['req-retry-1', 'req-retry-2']),
      selected('retry', 'primary', 0),
    ]);

    const invocation = replay.invocations.get(INVOCATION);
    expect(invocation).toMatchObject({ status: 'selected', selectedAttemptId: 'retry' });
    expect(invocation?.attempts.get('retry')).toMatchObject({
      status: 'selected', requestIds: ['req-retry-1', 'req-retry-2'],
    });
    expect(replay.diagnostics).toEqual([]);
  });

  it('replays fallback success without confusing the failed primary with the winner', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'failure', 0),
      attempt('fallback', 'fallback', 'success', 1), selected('fallback', 'fallback', 1),
    ]);

    const invocation = replay.invocations.get(INVOCATION);
    expect(invocation?.selectedAttemptId).toBe('fallback');
    expect(invocation?.attempts.get('primary')?.status).toBe('failed');
    expect(invocation?.attempts.get('fallback')?.status).toBe('selected');
  });

  it('keeps every terminal when fallback is exhausted', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'failure', 0),
      attempt('fallback', 'fallback', 'failure', 1),
      attempt('blocked', 'blocked', 'skipped', 2, []), exhausted(),
    ]);

    const invocation = replay.invocations.get(INVOCATION);
    expect(invocation?.status).toBe('exhausted');
    expect([...invocation!.attempts.values()].map(item => item.status)).toEqual([
      'failed', 'failed', 'cancelled',
    ]);
    expect(replay.diagnostics).toEqual([]);
  });

  it('replays a primary hedge winner and a discarded fallback', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'success', 0),
      attempt('fallback', 'fallback', 'discarded', 1), selected('primary', 'primary', 0),
    ]);

    expect(replay.invocations.get(INVOCATION)?.attempts.get('primary')?.status).toBe('selected');
    expect(replay.invocations.get(INVOCATION)?.attempts.get('fallback')?.status).toBe('discarded');
  });

  it('replays a fallback hedge winner and a discarded primary', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'discarded', 0),
      attempt('fallback', 'fallback', 'success', 1), selected('fallback', 'fallback', 1),
    ]);

    expect(replay.invocations.get(INVOCATION)?.selectedAttemptId).toBe('fallback');
    expect(replay.invocations.get(INVOCATION)?.attempts.get('primary')?.status).toBe('discarded');
  });

  it('replays a double-failed hedge as exhausted without inventing a winner', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'failure', 0),
      attempt('fallback', 'fallback', 'failure', 1), exhausted(),
    ]);

    const invocation = replay.invocations.get(INVOCATION);
    expect(invocation?.status).toBe('exhausted');
    expect(invocation?.selectedAttemptId).toBeUndefined();
  });

  it('is stable across acceptable reordering, a late loser, and repeated reload', () => {
    const normal = [
      started(), attempt('primary', 'primary', 'success', 0),
      selected('primary', 'primary', 0), attempt('fallback', 'fallback', 'discarded', 1),
    ];
    const reordered = [
      selected('primary', 'primary', 0), attempt('fallback', 'fallback', 'discarded', 1),
      started(), attempt('primary', 'primary', 'success', 0),
    ];

    const first = state(normal);
    const second = state(reordered);
    const third = InvocationSelectionLedger.replayJsonl(reordered.map(event => JSON.stringify(event)).join('\n'));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(second.invocations.get(INVOCATION)?.selectedAttemptId).toBe('primary');
  });

  it('keeps the first selection and first attempt terminal on duplicates', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'success', 0),
      attempt('fallback', 'fallback', 'success', 1),
      selected('primary', 'primary', 0), selected('fallback', 'fallback', 1),
      attempt('primary', 'primary', 'failure', 0),
    ]);

    const invocation = replay.invocations.get(INVOCATION);
    expect(invocation?.selectedAttemptId).toBe('primary');
    expect(invocation?.attempts.get('primary')?.status).toBe('selected');
    expect(invocation?.attempts.get('fallback')?.status).toBe('discarded');
    expect(replay.diagnostics.map(item => item.code)).toEqual([
      'duplicate_attempt_result', 'duplicate_selected',
    ]);
  });

  it('does not let race cleanup overwrite a selected attempt', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'success', 0), selected('primary', 'primary', 0),
      {
        type: 'race_loser_cleaned', schemaVersion: 1, invocationId: INVOCATION,
        attemptId: RECOVERY_ATTEMPT, providerAttemptId: 'primary', provider: 'primary', reason: 'late_cleanup',
      },
    ]);

    expect(replay.invocations.get(INVOCATION)?.attempts.get('primary')?.status).toBe('selected');
    expect(replay.diagnostics).toEqual([expect.objectContaining({ code: 'selected_cleanup_conflict' })]);
  });

  it('retains a reconstructable selection but marks a missing start corrupt', () => {
    const replay = state([
      attempt('primary', 'primary', 'success', 0), selected('primary', 'primary', 0),
    ]);

    expect(replay.invocations.get(INVOCATION)).toMatchObject({
      status: 'corrupt', selectedAttemptId: 'primary',
    });
    expect(replay.diagnostics).toEqual([expect.objectContaining({ code: 'missing_started' })]);
  });

  it('rejects an unknown selected attempt instead of inferring from provider name', () => {
    const replay = state([started(), selected('missing', 'primary', 9)]);

    expect(replay.invocations.get(INVOCATION)?.status).toBe('corrupt');
    expect(replay.invocations.get(INVOCATION)?.selectedAttemptId).toBeUndefined();
    expect(replay.diagnostics).toEqual([expect.objectContaining({ code: 'unknown_attempt' })]);
  });

  it('does not let a later duplicate repair an unknown first selection', () => {
    const replay = state([
      started(), attempt('primary', 'primary', 'success', 0),
      selected('missing', 'primary', 9), selected('primary', 'primary', 0),
    ]);

    expect(replay.invocations.get(INVOCATION)?.status).toBe('corrupt');
    expect(replay.invocations.get(INVOCATION)?.selectedAttemptId).toBeUndefined();
    expect(replay.diagnostics.map(item => item.code)).toEqual(['unknown_attempt', 'duplicate_selected']);
  });

  it('marks an exhausted invocation with a missing attempt terminal incomplete', () => {
    const replay = state([
      started(), attempt('pending', 'primary', 'running', 0, []), exhausted(),
    ]);

    expect(replay.invocations.get(INVOCATION)?.status).toBe('corrupt');
    expect(replay.diagnostics).toEqual([expect.objectContaining({ code: 'incomplete_invocation' })]);
  });

  it('leaves partial facts visible when JSONL is truncated', () => {
    const jsonl = `${JSON.stringify(started())}\n${JSON.stringify(attempt('primary', 'primary', 'success', 0))}\n{"type":"call_selection",`;
    const replay = InvocationSelectionLedger.replayJsonl(jsonl);

    expect(replay.invocations.get(INVOCATION)?.status).toBe('open');
    expect(replay.invocations.get(INVOCATION)?.attempts.get('primary')?.status).toBe('succeeded');
    expect(replay.diagnostics.map(item => item.code)).toEqual(['invalid_json', 'incomplete_invocation']);
  });

  it('reads legacy facts but explicitly marks missing schema and request links', () => {
    const legacyAttempt = attempt('primary', 'primary', 'success', 0);
    const legacySelection = selected('primary', 'primary', 0);
    delete legacyAttempt.schemaVersion;
    delete legacyAttempt.requestIds;
    delete legacySelection.schemaVersion;

    const replay = state([started(), legacyAttempt, legacySelection]);

    expect(replay.invocations.get(INVOCATION)?.selectedAttemptId).toBe('primary');
    expect(replay.diagnostics.map(item => item.code)).toEqual([
      'legacy_schema', 'legacy_request_link', 'legacy_schema',
    ]);
  });

  it('retains partial facts and reports an iterator failure', () => {
    function* broken(): Generator<unknown> {
      yield started();
      yield attempt('primary', 'primary', 'success', 0);
      throw new Error('read failed');
    }

    const replay = state(broken());

    expect(replay.invocations.get(INVOCATION)?.attempts.get('primary')?.status).toBe('succeeded');
    expect(replay.diagnostics.map(item => item.code)).toEqual(['replay_failed', 'incomplete_invocation']);
  });
});
