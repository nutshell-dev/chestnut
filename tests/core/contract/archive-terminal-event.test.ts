/**
 * Phase 1146 Step A: contract terminal audit record matcher tests.
 */
import { describe, it, expect } from 'vitest';
import { matchArchiveTerminalRecord } from '../../../src/core/contract/archive-terminal-event.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { ArchiveState, ContractId } from '../../../src/core/contract/types.js';
import type { AuditRecord } from '../../../src/foundation/audit/index.js';

const contractId = 'cid-1' as ContractId;
const otherContractId = 'cid-2' as ContractId;

function record(opts: {
  type: string;
  ts?: string;
  seq?: number;
  cols?: string[];
}): AuditRecord {
  return {
    ts: opts.ts ?? '2026-07-19T10:00:00.000Z',
    seq: opts.seq ?? 1,
    type: opts.type,
    cols: opts.cols ?? [],
  };
}

function terminalRecord(state: ArchiveState, idCol: 'camel' | 'snake' | 'both' | 'none' = 'camel', extraCols: string[] = []): AuditRecord {
  const eventMap: Record<ArchiveState, string> = {
    completed: CONTRACT_AUDIT_EVENTS.COMPLETED,
    cancelled: CONTRACT_AUDIT_EVENTS.CANCELLED,
    corrupted: CONTRACT_AUDIT_EVENTS.CORRUPTED,
  };
  const cols: string[] = [...extraCols];
  if (idCol === 'camel' || idCol === 'both') cols.push(`contractId=${contractId}`);
  if (idCol === 'snake' || idCol === 'both') cols.push(`contract_id=${contractId}`);
  return record({ type: eventMap[state], cols });
}

describe('matchArchiveTerminalRecord', () => {
  it('matches current camelCase contractId terminal records for all states', () => {
    for (const state of ['completed', 'cancelled', 'corrupted'] as ArchiveState[]) {
      const result = matchArchiveTerminalRecord(terminalRecord(state, 'camel'), { contractId, state });
      expect(result.kind).toBe('match');
      if (result.kind !== 'match') continue;
      expect(result.recordedAt).toBe('2026-07-19T10:00:00.000Z');
      expect(result.seq).toBe(1);
    }
  });

  it('matches legacy snake_case contract_id terminal records for all states', () => {
    for (const state of ['completed', 'cancelled', 'corrupted'] as ArchiveState[]) {
      const result = matchArchiveTerminalRecord(terminalRecord(state, 'snake'), { contractId, state });
      expect(result.kind).toBe('match');
    }
  });

  it('matches when both contractId and contract_id are present and equal', () => {
    const result = matchArchiveTerminalRecord(terminalRecord('completed', 'both'), { contractId, state: 'completed' });
    expect(result.kind).toBe('match');
  });

  it('returns no-match for wrong event type', () => {
    const result = matchArchiveTerminalRecord(
      record({ type: CONTRACT_AUDIT_EVENTS.CREATED, cols: [`contractId=${contractId}`] }),
      { contractId, state: 'completed' },
    );
    expect(result.kind).toBe('no-match');
  });

  it('returns no-match for a different contract id', () => {
    const result = matchArchiveTerminalRecord(
      terminalRecord('completed', 'camel'),
      { contractId: otherContractId, state: 'completed' },
    );
    expect(result.kind).toBe('no-match');
  });

  it('returns no-match when neither contractId nor contract_id is present', () => {
    const result = matchArchiveTerminalRecord(
      terminalRecord('completed', 'none'),
      { contractId, state: 'completed' },
    );
    expect(result.kind).toBe('no-match');
  });

  it('returns invalid when contractId and contract_id conflict and target matches one side', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      cols: ['contractId=cid-1', 'contract_id=cid-2'],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.reason).toBe('id_conflict');
  });

  it('returns invalid when conflict matches snake side but not camel side', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      cols: ['contractId=cid-2', 'contract_id=cid-1'],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.reason).toBe('id_conflict');
  });

  it('returns no-match when conflicting ids are both unrelated to target', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      cols: ['contractId=cid-2', 'contract_id=cid-3'],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('no-match');
  });

  it('does not substring-match xcontractId or similar fake keys', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      cols: ['xcontractId=cid-1'],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('no-match');
  });

  it('excludes cancelled abort_verifier_failed diagnostic rows from terminal', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.CANCELLED,
      cols: [`contractId=${contractId}`, 'abort_verifier_failed=true'],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'cancelled' });
    expect(result.kind).toBe('no-match');
  });

  it('matches cancelled rows without abort_verifier_failed', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.CANCELLED,
      cols: [`contractId=${contractId}`, 'reason=user_request'],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'cancelled' });
    expect(result.kind).toBe('match');
  });

  it('returns invalid for non-finite timestamp', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      ts: 'not-a-date',
      cols: [`contractId=${contractId}`],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.reason).toBe('invalid_timestamp');
  });

  it('returns invalid for far-future timestamp', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      ts: '999999-07-19T10:00:00.000Z',
      cols: [`contractId=${contractId}`],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.reason).toBe('invalid_timestamp');
  });

  it('preserves original timestamp string in match result', () => {
    const r = record({
      type: CONTRACT_AUDIT_EVENTS.COMPLETED,
      ts: '2026-07-19T10:05:30.123Z',
      cols: [`contractId=${contractId}`],
    });
    const result = matchArchiveTerminalRecord(r, { contractId, state: 'completed' });
    expect(result.kind).toBe('match');
    if (result.kind !== 'match') return;
    expect(result.recordedAt).toBe('2026-07-19T10:05:30.123Z');
  });
});
