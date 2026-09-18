/**
 * @module L4.ContractSystem.ArchiveQuery
 * Phase 1146 Step C: structured cross-claw archive contract query.
 * Phase 1370 Step C: the caller owns the claw universe (enumeration and role
 * filtering); this query only resolves and scans the caller-specified archive
 * roots via `Pick<ClawTopology, 'resolve'>`. Resolve failures and remote
 * locations become structured issues instead of discarding other entries.
 */

import * as path from 'node:path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { AUDIT_FILE } from '../../foundation/audit/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';

/** ClawTopology.resolve 的返回类型（barrel 未单独 export Location） */
type Location = ReturnType<ClawTopology['resolve']>;
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
 * Query archived contracts under caller-specified claws with structured
 * terminal-time resolution.
 *
 * - Known times are filtered inclusively by `[sinceMs, untilMs]`; unknown entries
 *   are always retained and make the result incomplete.
 * - Per-claw resolve/list failures and remote locations are recorded as issues
 *   and do not empty the result set.
 * - Output order is stable by `(clawId, state, contractId)` only; it does not
 *   claim a complete historical ordering.
 */
export async function queryArchiveContracts(opts: {
  fs: FileSystem;
  clawTopology: Pick<ClawTopology, 'resolve'>;
  clawIds: readonly ClawId[];
  filter?: ArchiveQueryFilter;
}): Promise<ArchiveQueryResult> {
  const { fs, clawTopology, clawIds, filter } = opts;
  const entries: ArchiveQueryEntry[] = [];
  const issues: ArchiveQueryIssue[] = [];
  let incomplete = false;

  for (const clawId of clawIds) {
    let location: Location;
    try {
      location = clawTopology.resolve(clawId);
    } catch (err) {
      issues.push({
        code: 'claw_resolve_failed',
        clawId,
        detail: `resolve failed for claw ${clawId}`,
        cause: err,
      });
      incomplete = true;
      continue;
    }

    if (location.kind !== 'local') {
      issues.push({
        code: 'remote_claw_unsupported',
        clawId,
        detail: `claw ${clawId} is remote; archive query is local-only`,
      });
      incomplete = true;
      continue;
    }

    const archiveDir = path.join(location.clawDir, CONTRACT_ARCHIVE_DIR);
    const auditPath = path.join(location.clawDir, AUDIT_FILE);

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

    for (const locationEntry of locations) {
      const contractId = makeContractId(locationEntry.contractId);
      // phase 1862 Step G (CT-D8)：resolveArchiveTime 单点产出完整 issue（含 clawId），
      // 此处只做收集，不再跨层 spread 重建。
      const { time, issues: timeIssues } = await resolveArchiveTime({
        fs,
        auditPath,
        location: locationEntry,
        contractId,
        clawId,
      });

      if (!keepEntry(time, filter)) continue;

      entries.push({
        clawId,
        contractId,
        state: entryState(locationEntry),
        contractDir: locationEntry.contractRoot,
        archiveTime: time,
      });

      if (timeIssues.length > 0) {
        issues.push(...timeIssues);
      }

      if (time.kind !== 'known' || timeIssues.length > 0) {
        incomplete = true;
      }
    }
  }

  entries.sort(sortEntries);

  return { entries, issues, incomplete };
}
