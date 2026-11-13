import { describe, expect, it } from 'vitest';
import {
  captureExecutionTarget,
  decodeExecutionTarget,
  observeExecutionTarget,
  type ExecutionGroupTarget,
} from '../../../src/foundation/process-exec/index.js';

const START_TIME = 'Mon Jan 01 00:00:00 2020';

describe('execution target persistence decode', () => {
  it('decodes v1 without asking ATS to validate PGID or startTime', () => {
    const result = decodeExecutionTarget({
      version: 1,
      leaderPid: 12345,
      processGroupId: 12345,
      leaderStartTime: START_TIME,
    });

    expect(result).toMatchObject({
      kind: 'decoded',
      target: {
        version: 1,
        leaderPid: 12345,
        processGroupId: 12345,
        leaderStartTime: START_TIME,
      },
    });
    expect(result.evidence.facts.length).toBeGreaterThan(0);
  });

  it('decodes legacy PID-only records as read-only targets', () => {
    const result = decodeExecutionTarget(undefined, 12345, START_TIME);
    expect(result).toMatchObject({
      kind: 'decoded',
      target: { version: 0, leaderPid: 12345, leaderStartTime: START_TIME },
    });
  });

  it('fails closed for conflicting, malformed, missing and future identities', () => {
    expect(decodeExecutionTarget({
      version: 1, leaderPid: 12345, processGroupId: 12346,
    })).toMatchObject({ kind: 'invalid', reason: 'invalid_execution_identity' });
    expect(decodeExecutionTarget({
      version: 1, leaderPid: 12345, processGroupId: 12345,
    }, 12345)).toMatchObject({ kind: 'invalid', reason: 'conflicting_execution_identities' });
    expect(decodeExecutionTarget(undefined)).toMatchObject({
      kind: 'invalid', reason: 'missing_execution_identity',
    });
    expect(decodeExecutionTarget({
      version: 2, leaderPid: 12345, processGroupId: 12345,
    })).toMatchObject({ kind: 'unsupported_version' });
  });
});

describe('execution target capture and observation', () => {
  it('captures a real leader startTime with evidence', () => {
    const result = captureExecutionTarget({
      leaderPid: process.pid,
      processGroupId: process.pid,
    });

    expect(result.kind).toBe('captured');
    if (result.kind !== 'captured') throw new Error('expected a captured target');
    expect(result.target.leaderStartTime).toEqual(expect.any(String));
    expect(result.evidence.facts.length).toBeGreaterThan(0);
  });

  it('keeps a missing group startTime unknown instead of authorizing termination', () => {
    const target: ExecutionGroupTarget = {
      version: 1,
      leaderPid: process.pid,
      processGroupId: process.pid,
    };
    const result = observeExecutionTarget(target);

    expect(result).toMatchObject({
      kind: 'unknown',
      reason: 'leader_start_time_unavailable',
      target,
    });
    expect(result.evidence.facts.length).toBeGreaterThan(0);
  });

  it('classifies a legacy PID/startTime mismatch as identity_changed inside L1', () => {
    const decoded = decodeExecutionTarget(undefined, process.pid, START_TIME);
    if (decoded.kind !== 'decoded') throw new Error('expected legacy target');
    const result = observeExecutionTarget(decoded.target);

    expect(result).toMatchObject({ kind: 'gone', reason: 'identity_changed' });
    if (result.kind === 'gone') expect(result.observedStartTime).not.toBe(START_TIME);
    expect(result.evidence.facts.length).toBeGreaterThan(0);
  });
});
