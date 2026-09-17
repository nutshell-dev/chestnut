/**
 * @module L4.ContractSystem.TerminalFact
 * phase 1846 Step B: read-only terminal fact query for a single contract id.
 *
 * Directory location is the lifecycle authority: only a current
 * `contract/archive/<state>/<id>` directory is terminal evidence. Progress
 * completion, persisted lifecycle intents and empty active lists are NOT
 * terminal commits and never produce a `terminal` result here.
 *
 * Strict semantics:
 * - `unconfirmed` means "no current terminal directory evidence observed";
 *   it does NOT mean active, paused, legacy-archived or nonexistent.
 * - I/O failures and layout conflicts are thrown as-is (or as the existing
 *   typed owner errors); they are never folded into `unconfirmed`.
 * - The query only depends on FileSystem.stat plus this module's own
 *   directory/type definitions. No registration, state, timers, background
 *   scans, audits, writes, caching or retries.
 *
 * Concurrency boundary: sequential stats are not an atomic snapshot. A rename
 * observed mid-scan surfaces as a conservative conflict/IO error; the next
 * call re-observes. This entry point provides no lock or lease.
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import {
  CONTRACT_ACTIVE_DIR,
  CONTRACT_ARCHIVE_DIR,
  CONTRACT_PAUSED_DIR,
} from './dirs.js';
import { archiveStateContainerDir, contractRoot } from './locations.js';
import { ARCHIVE_STATES, type ArchiveState, type ContractId } from './types.js';
import { ContractLayoutCorruptedError, ContractLocationAmbiguityError } from './errors.js';

export type ContractTerminalFact =
  | { kind: 'terminal'; state: ArchiveState }
  | { kind: 'unconfirmed' };

/**
 * ContractId is a compile-time brand, not a runtime guarantee. The id is used
 * as a single directory name, so reject anything that could escape or alias
 * directories before any filesystem access happens.
 */
function assertSingleDirectoryName(contractId: ContractId): void {
  if (
    contractId.length === 0 ||
    contractId === '.' ||
    contractId === '..' ||
    contractId.includes('/') ||
    contractId.includes('\\') ||
    contractId.includes('\0')
  ) {
    throw new TypeError(
      `readContractTerminalFact: contract id is not a single directory name: ${JSON.stringify(contractId)}`,
    );
  }
}

interface TerminalFactCandidate {
  root: string;
  /** Set only for current archive/<state>/<id> candidates. */
  state?: ArchiveState;
}

/**
 * Build the seven owner-defined candidates from module constants. Callers
 * never pass active/archive locations; path strategy stays in ContractSystem.
 */
function buildTerminalFactCandidates(contractId: ContractId): TerminalFactCandidate[] {
  const candidates: TerminalFactCandidate[] = [
    { root: contractRoot(CONTRACT_ACTIVE_DIR, contractId) },
    { root: contractRoot(CONTRACT_PAUSED_DIR, contractId) },
    { root: contractRoot(CONTRACT_ARCHIVE_DIR, contractId) },
  ];
  for (const state of ARCHIVE_STATES) {
    candidates.push({
      root: contractRoot(archiveStateContainerDir(CONTRACT_ARCHIVE_DIR, state), contractId),
      state,
    });
  }
  return candidates;
}

/**
 * Read the current terminal fact for `contractId` from the claw-rooted fs.
 *
 * Returns `terminal(state)` only when exactly one candidate directory exists
 * and it is a current `archive/<state>/<id>` directory. Returns `unconfirmed`
 * when no candidate directory exists or the sole directory is a non-terminal
 * location (active / legacy paused / legacy flat archive).
 *
 * @throws TypeError if `contractId` is not a single directory name (no stat performed).
 * @throws ContractLayoutCorruptedError if a candidate path exists but is not a directory.
 * @throws ContractLocationAmbiguityError if more than one candidate directory exists.
 * @throws any other stat error (EACCES/EIO/ENOTDIR/...) unchanged.
 */
export async function readContractTerminalFact(
  fs: Pick<FileSystem, 'stat'>,
  contractId: ContractId,
): Promise<ContractTerminalFact> {
  assertSingleDirectoryName(contractId);

  const found: TerminalFactCandidate[] = [];
  for (const candidate of buildTerminalFactCandidates(contractId)) {
    let info;
    try {
      info = await fs.stat(candidate.root);
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw error;
    }
    if (!info.isDirectory) {
      throw new ContractLayoutCorruptedError('Terminal fact path is not a directory', {
        root: candidate.root,
        cause: 'terminal_fact_non_directory',
      });
    }
    found.push(candidate);
  }

  if (found.length > 1) {
    throw new ContractLocationAmbiguityError(contractId, found.map(x => x.root));
  }

  const state = found[0]?.state;
  return state ? { kind: 'terminal', state } : { kind: 'unconfirmed' };
}
