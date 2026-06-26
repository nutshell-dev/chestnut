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
  CONTRACT_YAML_FILE,
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
