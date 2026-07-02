/**
 * @module L4.ContractSystem.LightweightQuery
 * 0-dep read-only contract query helpers for CLI/watchdog lightweight scenarios.
 * No ContractSystem instance required — encapsulates contract directory structure knowledge.
 * Sibling of onboarding-discovery.ts (readOnboardingStatus).
 *
 * @phase 744
 */

import * as path from 'path';
import { formatErr } from '../../foundation/node-utils/index.js';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_ARCHIVE_DIR,
  CONTRACT_YAML_FILE,
  PROGRESS_FILE,
} from './dirs.js';

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
 * Get the verification directory path for a contract.
 * Encapsulates contract/active/<id>/verification path construction.
 */
export function getContractVerificationDir(
  clawDir: string,
  contractId: string,
): string {
  return path.join(clawDir, CONTRACT_ACTIVE_DIR, contractId, 'verification');
}

/**
 * UTC epoch ms for 2020-01-01T00:00:00Z（contract ID 生成 base 时间锚）.
 * Derivation: Date.UTC(2020, 0, 1) = 1_577_836_800_000.
 */
const EPOCH_2020_01_01_MS = 1_577_836_800_000;

/**
 * Get the creation timestamp (epoch ms) of the first active contract.
 * Inlined from the deprecated getContractCreatedMs — prefer this for clearer business semantics.
 *
 * @returns epoch ms, or null if no active contract
 */
export function getActiveContractTimestamp(
  fs: FileSystem,
  clawDir: string,
  audit?: AuditLog,
): number | null {
  const activeDir = path.join(clawDir, CONTRACT_ACTIVE_DIR);
  if (!fs.existsSync(activeDir)) return null;
  try {
    const entries = fs.listSync(activeDir, { includeDirs: true });
    const contractDirs = entries.filter(e => e.isDirectory).sort();
    if (contractDirs.length === 0) return null;
    const first = contractDirs[0].name;
    // contractId format: <epochMs>-<hash>
    const ts = parseInt(first.split('-')[0], 10);
    if (isNaN(ts) || ts <= EPOCH_2020_01_01_MS) return null;
    return ts;
  } catch (err) {
    if (!isFileNotFound(err) && audit) {
      const code = (err as NodeJS.ErrnoException)?.code;
      audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
        `dir=${activeDir}`,
        `code=${code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
    return null;
  }
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
