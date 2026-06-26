/**
 * @module L4.ContractSystem.LightweightQuery
 * 0-dep read-only contract query helpers for CLI/watchdog lightweight scenarios.
 * No ContractSystem instance required — encapsulates contract directory structure knowledge.
 * Sibling of onboarding-discovery.ts (readOnboardingStatus) and utils.ts (getContractCreatedMs).
 *
 * @phase 744
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_ARCHIVE_DIR,
  CONTRACT_YAML_FILE,
  PROGRESS_FILE,
} from './dirs.js';
import { getContractCreatedMs } from './utils.js';

/** Lightweight contract summary for enumeration (CLI list / health check scenarios). */
export interface ContractSummary {
  /** Contract directory name (ts-hash format). */
  contractId: string;
  /** Title field from contract.yaml. Empty string if unreadable. */
  title: string;
  /** Contract state. Currently only 'active'; paused enumeration TBD. */
  state: 'active';
}

/**
 * Check whether clawDir has an active contract.
 * Lightweight: only lists contract/active/ directory, no file reads.
 */
export function hasActiveContract(fs: FileSystem, clawDir: string): boolean {
  const activeDir = path.join(clawDir, CONTRACT_ACTIVE_DIR);
  if (!fs.existsSync(activeDir)) return false;
  try {
    const entries = fs.listSync(activeDir, { includeDirs: true });
    return entries.some(e => e.isDirectory);
  } catch {
    /* silent: TOCTOU race — dir vanished between existsSync and listSync */
    return false;
  }
}

/**
 * Get the creation timestamp (epoch ms) of the first active contract.
 * Equivalent to getContractCreatedMs — prefer this for clearer business semantics.
 *
 * @returns epoch ms, or null if no active contract
 */
export function getActiveContractTimestamp(
  fs: FileSystem,
  clawDir: string,
): number | null {
  // Delegate to existing implementation; the deprecated alias is the canonical impl for now.
  // Once all callers migrate, the impl can move here.
  return getContractCreatedMs(fs, clawDir);
}

/**
 * Enumerate active contracts with lightweight metadata (id + title).
 * Reads contract.yaml frontmatter for each active contract directory.
 *
 * @returns sorted by contractId (lexical = creation order, since contractId starts with epoch ms)
 */
export function listActiveContracts(
  fs: FileSystem,
  clawDir: string,
): ContractSummary[] {
  const activeDir = path.join(clawDir, CONTRACT_ACTIVE_DIR);
  if (!fs.existsSync(activeDir)) return [];
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = fs.listSync(activeDir, { includeDirs: true });
  } catch {
    /* silent: TOCTOU race — dir vanished during listSync */
    return [];
  }
  const results: ContractSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const contractId = e.name;
    const yamlPath = path.join(activeDir, contractId, CONTRACT_YAML_FILE);
    let title = '';
    try {
      const raw = fs.readSync(yamlPath);
      const m = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      title = m?.[1] ?? '';
    } catch {
      /* silent: contract.yaml unreadable — leave title empty */
    }
    results.push({ contractId, title, state: 'active' });
  }
  return results.sort((a, b) => a.contractId.localeCompare(b.contractId));
}

/**
 * Contract metadata (started_at + title) from progress.json.
 */
export interface ContractMetadata {
  started_at?: string;
  title?: string;
}

/**
 * Get contract metadata (started_at, title) by contractId.
 * Scans archive first, then active — encapsulates the "where is contract data" knowledge.
 *
 * @returns null if contract not found in either location or data unreadable
 */
export function getContractMetadata(
  fs: FileSystem,
  clawDir: string,
  contractId: string,
): ContractMetadata | null {
  const archivePath = path.join(clawDir, CONTRACT_ARCHIVE_DIR, contractId, PROGRESS_FILE);
  const activePath = path.join(clawDir, CONTRACT_ACTIVE_DIR, contractId, PROGRESS_FILE);

  for (const p of [archivePath, activePath]) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw: unknown = JSON.parse(fs.readSync(p));
      if (typeof raw !== 'object' || raw === null) continue;
      const data = raw as Record<string, unknown>;
      const meta: ContractMetadata = {};
      if (typeof data.started_at === 'string') meta.started_at = data.started_at;
      if (typeof data.title === 'string') meta.title = data.title;
      if (meta.started_at || meta.title) return meta;
    } catch { /* silent: unreadable path — continue to next location */ }
  }
  return null;
}

/**
 * Read contract.yaml raw content by contractId (archive → active scan).
 * Lightweight equivalent of ContractSystem.readContractYamlRaw() — no instance required.
 *
 * @returns raw YAML string, or null if not found
 */
export function readContractYamlLightweight(
  fs: FileSystem,
  clawDir: string,
  contractId: string,
): string | null {
  const archivePath = path.join(clawDir, CONTRACT_ARCHIVE_DIR, contractId, CONTRACT_YAML_FILE);
  const activePath = path.join(clawDir, CONTRACT_ACTIVE_DIR, contractId, CONTRACT_YAML_FILE);

  for (const p of [archivePath, activePath]) {
    if (!fs.existsSync(p)) continue;
    try {
      return fs.readSync(p);
    } catch { /* silent: unreadable path — continue to next location */ }
  }
  return null;
}

/**
 * Read progress.json from an archive contract reference.
 * For consumers of listArchiveContracts() who need progress data.
 *
 * @param ref - from listArchiveContracts() (provides contractDir)
 * @returns null if unreadable
 */
export function readArchiveProgress(
  fs: FileSystem,
  ref: { contractDir: string },
): Record<string, unknown> | null {
  const progressPath = path.join(ref.contractDir, PROGRESS_FILE);
  try {
    const raw: unknown = JSON.parse(fs.readSync(progressPath));
    if (typeof raw !== 'object' || raw === null) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}
