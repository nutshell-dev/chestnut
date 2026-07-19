/**
 * @module L4.ContractSystem.Locations
 * phase 1127 Step B: typed contract location model and dual-topology resolver/list.
 *
 * Single-source of truth for archive state subdirectories:
 *   contract/archive/completed/<id>
 *   contract/archive/cancelled/<id>
 *   contract/archive/corrupted/<id>
 *   contract/archive/<legacy-id>  (flat legacy, read-only classification)
 *
 * All path construction for active/current archive/legacy flat goes through this file.
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_ARCHIVE_DIR, PROGRESS_FILE } from './dirs.js';
import { ARCHIVE_STATES, type ArchiveState, type ContractId, makeContractId } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { ContractLocationAmbiguityError, ContractLayoutCorruptedError } from './errors.js';
import { readCurrentContractLayout, getContractActiveCurrentRoot } from './new-layout.js';

export type ContractLocationKind = 'active' | 'archived-current' | 'archived-legacy';

export interface ContractLocation {
  kind: ContractLocationKind;
  /** Current archive state; only set when kind === 'archived-current'. */
  state?: ArchiveState;
  /** Parent directory (relative to clawDir), e.g. contract/active or contract/archive/completed. */
  containerDir: string;
  /** Full contract root directory (containerDir + contractId). */
  contractRoot: string;
}

export interface ArchiveListEntry {
  contractId: string;
  kind: 'current' | 'legacy';
  state?: ArchiveState;
  containerDir: string;
  contractRoot: string;
}

export function activeContainerDir(): string {
  return CONTRACT_ACTIVE_DIR;
}

export function archiveContainerDir(): string {
  return CONTRACT_ARCHIVE_DIR;
}

export function archiveStateContainerDir(archiveDir: string, state: ArchiveState): string {
  return `${archiveDir}/${state}`;
}

export function contractRoot(containerDir: string, contractId: ContractId): string {
  return `${containerDir}/${contractId}`;
}

export function contractProgressPath(contractRoot: string): string {
  return `${contractRoot}/${PROGRESS_FILE}`;
}

// ============================================================================
// Phase 1135 Step A: typed active contract location (current vs legacy)
// ============================================================================

export type ActiveContractLocation =
  | { layout: 'current'; contractId: ContractId; contractRoot: string }
  | { layout: 'legacy'; contractId: ContractId; contractRoot: string };

/**
 * Resolve the active runtime location for a contract id across the new
 * `active/current` slot and the legacy `active/<id>` directory.
 *
 * Precedence:
 *   1. If `active/current` exists, read it strictly and return the current root.
 *      - YAML id must equal the requested id.
 *      - Any corruption (missing yaml, schema invalid, etc.) throws; no fallback
 *        to the legacy active directory.
 *   2. If current does not exist, fall back to `active/<contractId>`.
 *   3. If neither exists, return null.
 */
export async function resolveActiveContractLocation(opts: {
  fs: FileSystem;
  audit: AuditLog;
  activeDir: string;
  contractId: ContractId;
}): Promise<ActiveContractLocation | null> {
  const { fs, audit, activeDir, contractId } = opts;
  const currentRoot = getContractActiveCurrentRoot();

  if (await fs.exists(currentRoot)) {
    const layout = await readCurrentContractLayout({ fs, audit });
    if (!layout) {
      audit.write(
        CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED,
        `root=${currentRoot}`,
        `cause=yaml_missing`,
        `contractId=${contractId}`,
      );
      throw new ContractLayoutCorruptedError(
        `active/current exists but contract.yaml is missing at ${currentRoot}`,
        { root: currentRoot, cause: 'yaml_missing', contractId },
      );
    }

    if (layout.contract.id !== contractId) {
      audit.write(
        CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED,
        `root=${currentRoot}`,
        `cause=yaml_id_mismatch`,
        `expected=${contractId}`,
        `actual=${layout.contract.id}`,
      );
      throw new ContractLayoutCorruptedError(
        `active/current contract id mismatch: expected ${contractId}, got ${layout.contract.id}`,
        { root: currentRoot, cause: 'yaml_id_mismatch', expectedId: contractId, actualId: layout.contract.id },
      );
    }

    return { layout: 'current', contractId, contractRoot: currentRoot };
  }

  const legacyRoot = `${activeDir}/${contractId}`;
  if (await fs.exists(legacyRoot)) {
    return { layout: 'legacy', contractId, contractRoot: legacyRoot };
  }

  return null;
}

/**
 * phase 1130 Step B: enumerate physical contract directories under the active container.
 *
 * Returns every direct child directory as a ContractId, regardless of progress.json
 * presence or validity. Non-directory entries are ignored. Missing activeDir is an
 * explicit empty state. Other fs.list errors are thrown (not swallowed) so capacity
 * checks fail-closed on I/O problems.
 */
export async function listPhysicalActiveContractIds(opts: {
  fs: FileSystem;
  activeDir: string;
}): Promise<ContractId[]> {
  if (!(await opts.fs.exists(opts.activeDir))) return [];
  const entries = await opts.fs.list(opts.activeDir, { includeDirs: true });
  return entries
    .filter(entry => entry.isDirectory)
    .map(entry => makeContractId(entry.name))
    .sort();
}

export function isArchiveStateContainer(name: string): name is ArchiveState {
  return (ARCHIVE_STATES as ReadonlySet<string>).has(name);
}

function auditAmbiguity(audit: AuditLog | undefined, contractId: ContractId, locations: string[]): void {
  audit?.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_MULTI_DIR,
    `contractId=${contractId}`,
    `dirs=${locations.join(',')}`,
    `context=resolveContractLocation`,
  );
}

/**
 * Resolve a single contract's location across active, current archive state dirs and legacy flat.
 *
 * Fail-closed when the same id exists in multiple locations (emit audit + throw).
 * Returns null when not found in any location.
 */
export async function resolveContractLocation(opts: {
  fs: FileSystem;
  activeDir: string;
  archiveDir: string;
  contractId: ContractId;
  audit?: AuditLog;
}): Promise<ContractLocation | null> {
  const { fs, activeDir, archiveDir, contractId, audit } = opts;
  const candidates: ContractLocation[] = [];

  const activeRoot = contractRoot(activeDir, contractId);
  if (await fs.exists(contractProgressPath(activeRoot))) {
    candidates.push({ kind: 'active', containerDir: activeDir, contractRoot: activeRoot });
  }

  for (const state of ARCHIVE_STATES) {
    const container = archiveStateContainerDir(archiveDir, state);
    const root = contractRoot(container, contractId);
    if (await fs.exists(contractProgressPath(root))) {
      candidates.push({ kind: 'archived-current', state, containerDir: container, contractRoot: root });
    }
  }

  const legacyRoot = contractRoot(archiveDir, contractId);
  if (await fs.exists(contractProgressPath(legacyRoot))) {
    candidates.push({ kind: 'archived-legacy', containerDir: archiveDir, contractRoot: legacyRoot });
  }

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const locations = candidates.map(c => c.contractRoot);
    auditAmbiguity(audit, contractId, locations);
    throw new ContractLocationAmbiguityError(contractId, locations);
  }
  return candidates[0];
}

/**
 * Synchronous variant of resolveContractLocation for 0-instance lightweight helpers.
 */
export function resolveContractLocationSync(opts: {
  fs: FileSystem;
  activeDir: string;
  archiveDir: string;
  contractId: ContractId;
  audit?: AuditLog;
}): ContractLocation | null {
  const { fs, activeDir, archiveDir, contractId, audit } = opts;
  const candidates: ContractLocation[] = [];

  const activeRoot = contractRoot(activeDir, contractId);
  if (fs.existsSync(contractProgressPath(activeRoot))) {
    candidates.push({ kind: 'active', containerDir: activeDir, contractRoot: activeRoot });
  }

  for (const state of ARCHIVE_STATES) {
    const container = archiveStateContainerDir(archiveDir, state);
    const root = contractRoot(container, contractId);
    if (fs.existsSync(contractProgressPath(root))) {
      candidates.push({ kind: 'archived-current', state, containerDir: container, contractRoot: root });
    }
  }

  const legacyRoot = contractRoot(archiveDir, contractId);
  if (fs.existsSync(contractProgressPath(legacyRoot))) {
    candidates.push({ kind: 'archived-legacy', containerDir: archiveDir, contractRoot: legacyRoot });
  }

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const locations = candidates.map(c => c.contractRoot);
    auditAmbiguity(audit, contractId, locations);
    throw new ContractLocationAmbiguityError(contractId, locations);
  }
  return candidates[0];
}

function listContainer(
  fs: FileSystem,
  containerDir: string,
  kind: 'current' | 'legacy',
  state?: ArchiveState,
): ArchiveListEntry[] {
  const results: ArchiveListEntry[] = [];
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = fs.listSync(containerDir, { includeDirs: true });
  } catch { // silent: containerDir 不存在/不可读 → 返回空列表（无 archive 即空集、caller 按空处理）
    return results;
  }
  for (const e of entries) {
    if (!e.isDirectory) continue;
    results.push({
      contractId: e.name,
      kind,
      state,
      containerDir,
      contractRoot: `${containerDir}/${e.name}`,
    });
  }
  return results;
}

/**
 * List archived contract locations across current state subdirectories and legacy flat.
 *
 * Does NOT read progress.json; entries are purely directory enumeration.
 * State container names (completed/cancelled/corrupted) are never returned as contract ids.
 */
export function listArchiveContractLocations(opts: {
  fs: FileSystem;
  archiveDir: string;
}): ArchiveListEntry[] {
  const { fs, archiveDir } = opts;
  const results: ArchiveListEntry[] = [];

  for (const state of ARCHIVE_STATES) {
    const container = archiveStateContainerDir(archiveDir, state);
    if (!fs.existsSync(container)) continue;
    results.push(...listContainer(fs, container, 'current', state));
  }

  if (fs.existsSync(archiveDir)) {
    const entries = fs.listSync(archiveDir, { includeDirs: true });
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (isArchiveStateContainer(e.name)) continue;
      results.push({
        contractId: e.name,
        kind: 'legacy',
        containerDir: archiveDir,
        contractRoot: `${archiveDir}/${e.name}`,
      });
    }
  }

  return results;
}

/**
 * Async variant of listArchiveContractLocations.
 */
export async function listArchiveContractLocationsAsync(opts: {
  fs: FileSystem;
  archiveDir: string;
}): Promise<ArchiveListEntry[]> {
  const { fs, archiveDir } = opts;
  const results: ArchiveListEntry[] = [];

  for (const state of ARCHIVE_STATES) {
    const container = archiveStateContainerDir(archiveDir, state);
    if (!(await fs.exists(container))) continue;
    const entries = await fs.list(container, { includeDirs: true });
    for (const e of entries) {
      if (!e.isDirectory) continue;
      results.push({
        contractId: e.name,
        kind: 'current',
        state,
        containerDir: container,
        contractRoot: `${container}/${e.name}`,
      });
    }
  }

  if (await fs.exists(archiveDir)) {
    const entries = await fs.list(archiveDir, { includeDirs: true });
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (isArchiveStateContainer(e.name)) continue;
      results.push({
        contractId: e.name,
        kind: 'legacy',
        containerDir: archiveDir,
        contractRoot: `${archiveDir}/${e.name}`,
      });
    }
  }

  return results;
}
