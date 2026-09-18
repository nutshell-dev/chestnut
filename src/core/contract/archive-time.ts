/**
 * @module L4.ContractSystem.ArchiveTime
 * Phase 1146 Step B: resolve archive terminal time from per-claw audit.
 *
 * Reads the current audit file for a single archive location and returns a
 * typed ArchiveTime: either a known terminal timestamp or an explicit unknown
 * reason. Legacy flat archives are always unresolved.
 */

import { createAuditReader } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { matchArchiveTerminalRecord } from './archive-terminal-event.js';
import type { ArchiveListEntry } from './locations.js';
import type { ArchiveQueryIssue, ArchiveTime, ContractId } from './types.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';

export async function resolveArchiveTime(opts: {
  fs: FileSystem;
  auditPath: string;
  location: ArchiveListEntry;
  contractId: ContractId;
  /**
   * phase 1862 Step G (CT-D8)：issue 的最终形状（含 clawId 上下文）在本模块单点
   * 产出——caller 不再事后 spread 补 clawId。
   */
  clawId: ClawId;
}): Promise<{ time: ArchiveTime; issues: ArchiveQueryIssue[] }> {
  const { fs, auditPath, location, contractId, clawId } = opts;
  const issues: ArchiveQueryIssue[] = [];

  if (location.kind === 'legacy') {
    const time: ArchiveTime = { kind: 'unknown', reason: 'legacy_state_unresolved' };
    issues.push({
      code: 'legacy_state_unresolved',
      clawId,
      contractId,
      detail: `legacy archive at ${location.contractRoot}`,
    });
    return { time, issues };
  }

  const state = location.state;
  if (!state) {
    const time: ArchiveTime = { kind: 'unknown', reason: 'terminal_event_unavailable' };
    issues.push({
      code: 'terminal_event_unavailable',
      clawId,
      contractId,
      detail: 'current archive entry missing state',
    });
    return { time, issues };
  }

  try {
    if (!fs.existsSync(auditPath)) {
      const time: ArchiveTime = { kind: 'unknown', reason: 'audit_file_missing' };
      issues.push({
        code: 'audit_file_missing',
        clawId,
        contractId,
        detail: `audit not found: ${auditPath}`,
      });
      return { time, issues };
    }
  } catch (err) {
    const time: ArchiveTime = { kind: 'unknown', reason: 'audit_read_failed' };
    issues.push({
      code: 'audit_read_failed',
      clawId,
      contractId,
      detail: 'stat audit failed',
      cause: err,
    });
    return { time, issues };
  }

  try {
    const reader = createAuditReader(fs, auditPath);
    const matches: Array<{ recordedAt: string; seq: number }> = [];
    const invalidDetails: string[] = [];

    for await (const record of reader.read({ typePattern: 'contract_*' })) {
      const result = matchArchiveTerminalRecord(record, { contractId, state });
      if (result.kind === 'no-match') continue;
      if (result.kind === 'invalid') {
        invalidDetails.push(`seq=${record.seq} reason=${result.reason}`);
        continue;
      }
      matches.push({ recordedAt: result.recordedAt, seq: result.seq });
    }

    if (invalidDetails.length > 0) {
      const time: ArchiveTime = { kind: 'unknown', reason: 'invalid_terminal_record' };
      issues.push({
        code: 'invalid_terminal_record',
        clawId,
        contractId,
        detail: invalidDetails.join('; '),
      });
      return { time, issues };
    }

    if (matches.length === 0) {
      const time: ArchiveTime = { kind: 'unknown', reason: 'terminal_event_unavailable' };
      issues.push({
        code: 'terminal_event_unavailable',
        clawId,
        contractId,
        detail: `no terminal record for ${contractId} in ${auditPath}`,
      });
      return { time, issues };
    }

    if (matches.length > 1) {
      const time: ArchiveTime = { kind: 'unknown', reason: 'ambiguous_terminal_records' };
      issues.push({
        code: 'ambiguous_terminal_records',
        clawId,
        contractId,
        detail: matches.map(m => `seq=${m.seq}`).join('; '),
      });
      return { time, issues };
    }

    const only = matches[0];
    const epochMs = new Date(only.recordedAt).getTime();
    const time: ArchiveTime = {
      kind: 'known',
      recordedAt: only.recordedAt,
      epochMs,
      source: 'terminal_audit',
    };
    return { time, issues };
  } catch (err) {
    const time: ArchiveTime = { kind: 'unknown', reason: 'audit_read_failed' };
    issues.push({
      code: 'audit_read_failed',
      clawId,
      contractId,
      detail: 'read audit failed',
      cause: err,
    });
    return { time, issues };
  }
}
