/**
 * @module L4.ContractSystem.ArchiveQuery
 * Phase 1146 Step C: structured cross-claw archive contract query.
 *
 * Enumerates archive locations across all claws, resolves terminal times from
 * per-claw audit, and returns a structured result with conservative filtering.
 * Does not read archive payloads and does not alter the legacy listArchiveContracts
 * API consumed by random-dream.
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { AUDIT_FILE } from '../../foundation/audit/index.js';
import { CLAWS_DIR } from '../../core/claw-topology/claw-instance-paths.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { CONTRACT_ARCHIVE_DIR } from './dirs.js';
import { listArchiveContractLocationsAsync, type ArchiveListEntry } from './locations.js';
import { resolveArchiveTime } from './archive-time.js';
import type {
  ArchiveQueryEntry,
  ArchiveQueryFilter,
  ArchiveQueryIssue,
  ArchiveQueryResult,
  ArchiveState,
} from './types.js';
import { makeContractId } from './types.js';

function archiveDirForClaw(clawId: string): string {
  return `${CLAWS_DIR}/${clawId}/${CONTRACT_ARCHIVE_DIR}`;
}

function auditPathForClaw(clawId: string): string {
  return `${CLAWS_DIR}/${clawId}/${AUDIT_FILE}`;
}

function entryState(location: ArchiveListEntry): ArchiveState | 'legacy-unresolved' {
  return location.kind === 'legacy' ? 'legacy-unresolved' : location.state!;
}

function keepEntry(time: { kind: 'known'; epochMs: number } | { kind: 'unknown' }, filter?: ArchiveQueryFilter): boolean {
  if (time.kind !== 'known') return true;
  if (filter?.sinceMs !== undefined && time.epochMs < filter.sinceMs) return false;
  if (filter?.untilMs !== undefined && time.epochMs > filter.untilMs) return false;
  return true;
}

function sortEntries(a: ArchiveQueryEntry, b: ArchiveQueryEntry): number {
  const clawCmp = a.clawId.localeCompare(b.clawId);
  if (clawCmp !== 0) return clawCmp;
  const stateCmp = a.state.localeCompare(b.state);
  if (stateCmp !== 0) return stateCmp;
  return a.contractId.localeCompare(b.contractId);
}

/**
 * Query archived contracts across all claws with structured terminal-time resolution.
 *
 * - Known times are filtered inclusively by `[sinceMs, untilMs]`; unknown entries
 *   are always retained and make the result incomplete.
 * - Claw/archive enumeration failures are recorded as issues and do not empty the
 *   result set.
 * - Output order is stable by `(clawId, state, contractId)` only; it does not
 *   claim a complete historical ordering.
 */
export async function queryArchiveContracts(opts: {
  fs: FileSystem;
  filter?: ArchiveQueryFilter;
}): Promise<ArchiveQueryResult> {
  const { fs, filter } = opts;
  const entries: ArchiveQueryEntry[] = [];
  const issues: ArchiveQueryIssue[] = [];
  let incomplete = false;

  if (!(await fs.exists(CLAWS_DIR))) {
    return { entries, issues, incomplete };
  }

  let clawEntries: { name: string; isDirectory: boolean }[];
  try {
    clawEntries = await fs.list(CLAWS_DIR, { includeDirs: true });
  } catch (err) {
    // silent: query returns structured issue to caller instead of throwing
    issues.push({
      code: 'claw_list_failed',
      detail: `list claws directory failed: ${CLAWS_DIR}`,
      cause: err,
    });
    return { entries, issues, incomplete: true };
  }

  for (const clawEntry of clawEntries) {
    if (!clawEntry.isDirectory) continue;
    const clawId = makeClawId(clawEntry.name);
    const archiveDir = archiveDirForClaw(clawId);

    let locations: ArchiveListEntry[];
    try {
      locations = await listArchiveContractLocationsAsync({ fs, archiveDir });
    } catch (err) {
      issues.push({
        code: 'archive_list_failed',
        clawId,
        detail: `list archive failed for claw ${clawId}`,
        cause: err,
      });
      incomplete = true;
      continue;
    }

    const auditPath = auditPathForClaw(clawId);

    for (const location of locations) {
      const contractId = makeContractId(location.contractId);
      const { time, issues: timeIssues } = await resolveArchiveTime({
        fs,
        auditPath,
        location,
        contractId,
      });

      if (!keepEntry(time, filter)) continue;

      entries.push({
        clawId,
        contractId,
        state: entryState(location),
        contractDir: location.contractRoot,
        archiveTime: time,
      });

      if (timeIssues.length > 0) {
        issues.push(...timeIssues.map(i => ({ ...i, clawId })));
      }

      if (time.kind !== 'known' || timeIssues.length > 0) {
        incomplete = true;
      }
    }
  }

  entries.sort(sortEntries);

  return { entries, issues, incomplete };
}
