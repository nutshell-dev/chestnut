/**
 * @module L4.ContractSystem.ArchiveTerminalEvent
 * Phase 1146 Step A: pure matcher for contract terminal audit records.
 *
 * Zero I/O. Operates on generic AuditRecord and decides whether the row proves
 * a given {contractId, ArchiveState} reached terminal commit after rename.
 */

import type { AuditRecord } from '../../foundation/audit/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { ArchiveState, ContractId } from './types.js';

export type TerminalRecordInvalidReason =
  | 'id_conflict'
  | 'invalid_timestamp';

export type TerminalRecordMatch =
  | { kind: 'match'; recordedAt: string; seq: number }
  | { kind: 'no-match' }
  | { kind: 'invalid'; reason: TerminalRecordInvalidReason };

const STATE_TO_EVENT: Readonly<Record<ArchiveState, string>> = {
  completed: CONTRACT_AUDIT_EVENTS.COMPLETED,
  cancelled: CONTRACT_AUDIT_EVENTS.CANCELLED,
  corrupted: CONTRACT_AUDIT_EVENTS.CORRUPTED,
};

function parseExactCol(cols: readonly string[], key: string): string | undefined {
  for (const col of cols) {
    const eqIdx = col.indexOf('=');
    if (eqIdx === -1) continue;
    if (col.slice(0, eqIdx) === key) {
      return col.slice(eqIdx + 1);
    }
  }
  return undefined;
}

function isFiniteEpochMs(ts: string): boolean {
  const n = new Date(ts).getTime();
  return Number.isFinite(n);
}

/**
 * Decide whether `record` is a post-rename terminal audit row for
 * `{ contractId, state }`.
 *
 * Rules:
 * - Event type must map from the expected ArchiveState.
 * - Accepts either `contractId=` (current writer style) or `contract_id=` (legacy
 *   Foundation typed projection) as the contract identifier.
 * - If both id columns are present and differ, the row is invalid.
 * - For cancelled events, rows carrying `abort_verifier_failed` are abort-failure
 *   diagnostics before lifecycle commit and therefore never match terminal.
 * - Timestamp must parse to a finite epoch.
 */
export function matchArchiveTerminalRecord(
  record: AuditRecord,
  expected: { contractId: ContractId; state: ArchiveState },
): TerminalRecordMatch {
  if (record.type !== STATE_TO_EVENT[expected.state]) {
    return { kind: 'no-match' };
  }

  const camelId = parseExactCol(record.cols, 'contractId');
  const snakeId = parseExactCol(record.cols, 'contract_id');

  if (camelId !== undefined && snakeId !== undefined && camelId !== snakeId) {
    return { kind: 'invalid', reason: 'id_conflict' };
  }

  const matchedId = camelId ?? snakeId;
  if (matchedId === undefined) {
    return { kind: 'no-match' };
  }
  if (matchedId !== expected.contractId) {
    return { kind: 'no-match' };
  }

  if (expected.state === 'cancelled' && parseExactCol(record.cols, 'abort_verifier_failed') !== undefined) {
    return { kind: 'no-match' };
  }

  if (!isFiniteEpochMs(record.ts)) {
    return { kind: 'invalid', reason: 'invalid_timestamp' };
  }

  return { kind: 'match', recordedAt: record.ts, seq: record.seq };
}
