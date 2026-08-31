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
 * All path construction for active/<id>, archive state subdirs, and legacy flat goes through this file.
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_ARCHIVE_DIR, PROGRESS_FILE } from './dirs.js';
import { ARCHIVE_STATES, type ArchiveState, type ContractId, makeContractId } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { ContractLocationAmbiguityError } from './errors.js';
import { classifyActivePublication, classifyActivePublicationSync, isActivePublished } from './creation.js';

export type ContractLocation =
  | { kind: 'active'; containerDir: string; contractRoot: string }
  | { kind: 'archived-current'; state: ArchiveState; containerDir: string; contractRoot: string }
  | { kind: 'archived-legacy'; containerDir: string; contractRoot: string };

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
// Phase 1135 Step A: typed active contract location
// Phase 1193 Step A: active layout is now the single `active/<id>` directory.
// ============================================================================

export interface ActiveContractLocation {
  contractId: ContractId;
  contractRoot: string;
}

/**
 * Resolve the active runtime location for a contract id.
 *
 * Active runtime only uses `active/<contractId>`. Returns null when not found.
 */
export async function resolveActiveContractLocation(opts: {
  fs: FileSystem;
  activeDir: string;
  contractId: ContractId;
}): Promise<ActiveContractLocation | null> {
  const { fs, activeDir, contractId } = opts;
  const root = `${activeDir}/${contractId}`;
  if (!(await fs.exists(root))) return null;

  const publication = await classifyActivePublication({ fs, contractRoot: root });
  if (!isActivePublished(publication)) return null;

  return { contractId, contractRoot: root };
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
  const results: ContractId[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const contractRoot = `${opts.activeDir}/${entry.name}`;
    const publication = await classifyActivePublication({ fs: opts.fs, contractRoot });
    if (isActivePublished(publication)) {
      results.push(makeContractId(entry.name));
    }
  }
  return results.sort();
}

function isArchiveStateContainer(name: string): name is ArchiveState {
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

type ResolveOnceResult =
  | { tag: 'found'; location: ContractLocation }
  | { tag: 'not_found' }
  | { tag: 'ambiguous'; locations: string[] };

async function resolveContractLocationOnce(opts: {
  fs: FileSystem;
  activeDir: string;
  archiveDir: string;
  contractId: ContractId;
}): Promise<ResolveOnceResult> {
  const { fs, activeDir, archiveDir, contractId } = opts;
  const candidates: ContractLocation[] = [];

  const activeRoot = contractRoot(activeDir, contractId);
  if (await fs.exists(activeRoot)) {
    const publication = await classifyActivePublication({ fs, contractRoot: activeRoot });
    if (isActivePublished(publication)) {
      candidates.push({ kind: 'active', containerDir: activeDir, contractRoot: activeRoot });
    }
  }

  for (const state of ARCHIVE_STATES) {
    const container = archiveStateContainerDir(archiveDir, state);
    const root = contractRoot(container, contractId);
    if (await fs.exists(root)) {
      candidates.push({ kind: 'archived-current', state, containerDir: container, contractRoot: root });
    }
  }

  const legacyRoot = contractRoot(archiveDir, contractId);
  if (await fs.exists(legacyRoot)) {
    candidates.push({ kind: 'archived-legacy', containerDir: archiveDir, contractRoot: legacyRoot });
  }

  if (candidates.length === 0) return { tag: 'not_found' };
  if (candidates.length > 1) {
    return { tag: 'ambiguous', locations: candidates.map(c => c.contractRoot) };
  }
  return { tag: 'found', location: candidates[0] };
}

/**
 * Resolve a single contract's location across active, current archive state dirs and legacy flat.
 *
 * Fail-closed when the same id exists in multiple locations (emit audit + throw).
 * Returns null when not found in any location.
 *
 * Phase 1310 Step C: retry once on transient active↔archive TOCTOU ambiguity;
 * persistent dual-location still fail-closed.
 */
export async function resolveContractLocation(opts: {
  fs: FileSystem;
  activeDir: string;
  archiveDir: string;
  contractId: ContractId;
  audit?: AuditLog;
}): Promise<ContractLocation | null> {
  const { contractId, audit } = opts;
  const first = await resolveContractLocationOnce(opts);
  // Fast path: unambiguous result.
  if (first.tag === 'found') return first.location;
  if (first.tag === 'not_found') return null;

  // Transient ambiguity can happen when a concurrent lifecycle move renames
  // active/<id> to archive/<state>/<id> while we are scanning. Retry once.
  const second = await resolveContractLocationOnce(opts);
  if (second.tag === 'found') return second.location;
  if (second.tag === 'not_found') return null;

  const locations = first.locations;
  auditAmbiguity(audit, contractId, locations);
  throw new ContractLocationAmbiguityError(contractId, locations);
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
  if (fs.existsSync(activeRoot)) {
    const publication = classifyActivePublicationSync({ fs, contractRoot: activeRoot });
    if (isActivePublished(publication)) {
      candidates.push({ kind: 'active', containerDir: activeDir, contractRoot: activeRoot });
    }
  }

  for (const state of ARCHIVE_STATES) {
    const container = archiveStateContainerDir(archiveDir, state);
    const root = contractRoot(container, contractId);
    if (fs.existsSync(root)) {
      candidates.push({ kind: 'archived-current', state, containerDir: container, contractRoot: root });
    }
  }

  const legacyRoot = contractRoot(archiveDir, contractId);
  if (fs.existsSync(legacyRoot)) {
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
