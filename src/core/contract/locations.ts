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
import { ARCHIVE_STATES, type ArchiveState, type ContractId } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { ContractLocationAmbiguityError } from './errors.js';

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
  } catch {
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
