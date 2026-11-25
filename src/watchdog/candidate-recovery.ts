/**
 * @module L6.Watchdog.CandidateRecovery
 * Persistent recovery-window admission for watchdog candidates.
 *
 * The active-directory rename remains the only winner authority. This module only
 * bounds candidate creation: fixed per-window slot directories are committed by
 * atomic directory rename, so concurrent callers cannot increment a shared JSON
 * counter or exceed the persisted budget. There is deliberately no process lock.
 */
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { formatErr, newUuid, sha256Hex } from '../foundation/node-utils/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { WATCHDOG_PATHS } from './layout.js';
import { getAuditWriter } from './watchdog-context.js';

const WINDOW_FILE = 'window.json';
const ADMISSION_FILE = 'admission.json';
const WINNER_FILE = 'winner.json';
const CLOSED_FILE = 'closed.json';
const SCHEMA_VERSION = 1;
const WINDOW_SEED_SCHEMA_VERSION = 2;

/** Initial bound for one recovery epoch; later production evidence may recalibrate it. */
export const WATCHDOG_CANDIDATE_BUDGET = 4;
export const WATCHDOG_CANDIDATE_ATTEMPT_ENV = 'CHESTNUT_WATCHDOG_ATTEMPT_ID';

export interface WatchdogRecoveryWindow {
  readonly windowId: string;
  readonly openedAtMs: number;
  /** Monotonic recovery-chain depth; avoids wall-clock ties selecting an old epoch. */
  readonly generation: number;
  readonly candidateCount: number;
  readonly lastCandidateAtMs: number | null;
  readonly budget: number;
  readonly state: 'open' | 'winner_committed' | 'exhausted' | 'closed';
  readonly winnerAttemptId?: string;
}

export interface WatchdogCandidateAdmission {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly windowId: string;
  readonly slot: number;
  readonly admittedAtMs: number;
  readonly callerPid: number;
}

export type WatchdogCandidateAdmissionResult =
  | { kind: 'admitted'; admission: WatchdogCandidateAdmission; window: WatchdogRecoveryWindow }
  | {
      kind: 'rejected';
      reason: 'budget_exhausted' | 'window_closed';
      attemptId: string;
      windowId: string;
      window: WatchdogRecoveryWindow;
    };

type Predecessor = { readonly kind: 'attempt' | 'window'; readonly id: string };

interface WindowSeedBase {
  readonly windowId: string;
  readonly openedAtMs: number;
  readonly generation: number;
  readonly budget: number;
  readonly state: 'open';
}

interface WindowSeedV1 extends WindowSeedBase {
  readonly schemaVersion: 1;
}

interface WindowSeedV2 extends WindowSeedBase {
  readonly schemaVersion: 2;
  readonly predecessor: Predecessor;
}

type WindowSeed = WindowSeedV1 | WindowSeedV2;

interface WindowOwnerFact {
  readonly attempt_id: string;
  readonly owner_token: string;
  readonly pid: number;
  readonly recovery_window_id?: string;
}

export interface CandidateRecoveryOptions {
  readonly budget?: number;
  readonly nowMs?: number;
}

function windowsDir(): string {
  return `${WATCHDOG_PATHS.recovery}/windows`;
}

function windowDir(windowId: string): string {
  return `${windowsDir()}/${windowId}`;
}

function attemptsDir(windowId: string): string {
  return `${windowDir(windowId)}/attempts`;
}

function candidateDir(attemptId: string): string {
  return `${WATCHDOG_PATHS.candidates}/${attemptId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotFound(error: unknown): boolean {
  return isFileNotFound(error);
}

function isExists(error: unknown): boolean {
  return isObject(error) && error.code === 'EEXIST';
}

function isNameTooLong(error: unknown): boolean {
  return isObject(error) && error.code === 'ENAMETOOLONG';
}

function parsePredecessor(value: unknown): Predecessor {
  if (!isObject(value) || (value.kind !== 'attempt' && value.kind !== 'window') ||
      typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('Invalid watchdog recovery window predecessor');
  }
  return { kind: value.kind, id: value.id };
}

function parseWindowSeed(raw: string): WindowSeed {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) ||
      (value.schemaVersion !== SCHEMA_VERSION && value.schemaVersion !== WINDOW_SEED_SCHEMA_VERSION) ||
      typeof value.windowId !== 'string' || value.windowId.length === 0 ||
      typeof value.openedAtMs !== 'number' || !Number.isFinite(value.openedAtMs) ||
      typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      typeof value.budget !== 'number' || !Number.isSafeInteger(value.budget) || value.budget < 1 ||
      value.state !== 'open') {
    throw new Error('Invalid watchdog recovery window record');
  }
  if (value.schemaVersion === WINDOW_SEED_SCHEMA_VERSION) {
    parsePredecessor(value.predecessor);
  }
  return value as unknown as WindowSeed;
}

function parseAdmission(raw: string): WatchdogCandidateAdmission {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.attemptId !== 'string' || value.attemptId.length === 0 ||
      typeof value.windowId !== 'string' || value.windowId.length === 0 ||
      typeof value.slot !== 'number' || !Number.isSafeInteger(value.slot) || value.slot < 0 ||
      typeof value.admittedAtMs !== 'number' || !Number.isFinite(value.admittedAtMs) ||
      typeof value.callerPid !== 'number') {
    throw new Error('Invalid watchdog candidate admission record');
  }
  return value as unknown as WatchdogCandidateAdmission;
}

function readWindowSeed(fs: FileSystem, windowId: string): WindowSeed {
  const seed = parseWindowSeed(fs.readSync(`${windowDir(windowId)}/${WINDOW_FILE}`));
  if (seed.windowId !== windowId) throw new Error(`Recovery window identity mismatch: ${windowId}`);
  return seed;
}

function readMarker(fs: FileSystem, windowId: string, name: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readSync(`${windowDir(windowId)}/${name}`));
    if (!isObject(value)) throw new Error(`Invalid watchdog recovery ${name}`);
    return value;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function readCommittedAdmissions(fs: FileSystem, windowId: string): WatchdogCandidateAdmission[] {
  let entries;
  try {
    entries = fs.listSync(attemptsDir(windowId), { includeDirs: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const admissions: WatchdogCandidateAdmission[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name.startsWith('.')) continue;
    const admission = parseAdmission(fs.readSync(`${attemptsDir(windowId)}/${entry.name}/${ADMISSION_FILE}`));
    if (admission.windowId !== windowId) {
      throw new Error(`Candidate admission window mismatch: ${admission.attemptId}`);
    }
    admissions.push(admission);
  }
  return admissions.sort((a, b) => a.slot - b.slot);
}

function readActiveWinner(fs: FileSystem, windowId: string): string | undefined {
  try {
    const value: unknown = JSON.parse(fs.readSync(`${WATCHDOG_PATHS.active}/owner.json`));
    if (isObject(value) && value.recovery_window_id === windowId && typeof value.attempt_id === 'string') {
      return value.attempt_id;
    }
  } catch (error) {
    if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

/** Rebuild a window summary solely from durable window/attempt/marker facts. */
export function inspectWatchdogRecoveryWindow(
  fs: FileSystem,
  windowId: string,
): WatchdogRecoveryWindow {
  const seed = readWindowSeed(fs, windowId);
  const admissions = readCommittedAdmissions(fs, windowId);
  const closed = readMarker(fs, windowId, CLOSED_FILE);
  const winner = readMarker(fs, windowId, WINNER_FILE);
  const markerWinner = typeof winner?.attemptId === 'string' ? winner.attemptId : undefined;
  const winnerAttemptId = markerWinner ?? readActiveWinner(fs, windowId);
  const state = closed
    ? 'closed'
    : winnerAttemptId
      ? 'winner_committed'
      : admissions.length >= seed.budget
        ? 'exhausted'
        : 'open';
  return {
    windowId,
    openedAtMs: seed.openedAtMs,
    generation: seed.generation,
    candidateCount: admissions.length,
    lastCandidateAtMs: admissions.length === 0
      ? null
      : Math.max(...admissions.map((admission) => admission.admittedAtMs)),
    budget: seed.budget,
    state,
    ...(winnerAttemptId ? { winnerAttemptId } : {}),
  };
}

export function listWatchdogRecoveryWindows(fs: FileSystem): WatchdogRecoveryWindow[] {
  let entries;
  try {
    entries = fs.listSync(windowsDir(), { includeDirs: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const windows = entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
    .map((entry) => inspectWatchdogRecoveryWindow(fs, entry.name));
  const windowIds = new Set(windows.map((window) => window.windowId));
  for (const window of windows) {
    const seed = readWindowSeed(fs, window.windowId);
    if (seed.schemaVersion !== WINDOW_SEED_SCHEMA_VERSION) continue;
    const legacyId = legacySuccessorId(seed.predecessor);
    if (legacyId && windowIds.has(legacyId)) {
      throw new Error(`Recovery successor divergence: ${legacyId} and ${window.windowId}`);
    }
  }
  return windows.sort((a, b) =>
    a.generation - b.generation || a.openedAtMs - b.openedAtMs || a.windowId.localeCompare(b.windowId));
}

function boundedSuccessorId(predecessor: Predecessor): string {
  return `rw2-${sha256Hex(JSON.stringify([predecessor.kind, predecessor.id]))}`;
}

function legacySuccessorId(predecessor: Predecessor): string | undefined {
  const candidate = `recovery-after-${predecessor.id}`;
  return Buffer.byteLength(candidate, 'utf8') <= 255 ? candidate : undefined;
}

interface WindowSelection {
  readonly windowId: string;
  readonly generation: number;
  readonly predecessor?: Predecessor;
  readonly expectedSeedVersion?: 1;
}

function assertWindowAbsent(fs: FileSystem, windowId: string): void {
  if (fs.existsSync(windowDir(windowId)) || fs.existsSync(`${windowDir(windowId)}/${WINDOW_FILE}`)) {
    throw new Error(`Incomplete watchdog recovery window: ${windowId}`);
  }
}

function probeWindow(
  fs: FileSystem,
  windowId: string,
  allowUnaddressable: boolean,
): WatchdogRecoveryWindow | null {
  try {
    readWindowSeed(fs, windowId);
  } catch (error) {
    if (allowUnaddressable && isNameTooLong(error)) return null;
    if (!isNotFound(error)) throw error;
    assertWindowAbsent(fs, windowId);
    return null;
  }
  try {
    // Once the legacy seed is addressable, later failures are corruption or I/O
    // errors, not proof that the old path itself is unaddressable.
    return inspectWatchdogRecoveryWindow(fs, windowId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    assertWindowAbsent(fs, windowId);
    return null;
  }
}

function selectSuccessorWindow(
  fs: FileSystem,
  predecessor: Predecessor,
  generation: number,
): WindowSelection {
  const legacyId = legacySuccessorId(predecessor);
  const boundedId = boundedSuccessorId(predecessor);
  const legacy = legacyId ? probeWindow(fs, legacyId, true) : null;
  const bounded = probeWindow(fs, boundedId, false);
  if (legacy && bounded) {
    throw new Error(`Recovery successor divergence: ${legacyId} and ${boundedId}`);
  }
  return {
    windowId: legacy ? legacyId! : boundedId,
    generation,
    predecessor,
  };
}

function selectWindow(fs: FileSystem, staleOwner: WindowOwnerFact | null): WindowSelection {
  if (staleOwner) {
    const parent = staleOwner.recovery_window_id
      ? inspectWatchdogRecoveryWindow(fs, staleOwner.recovery_window_id)
      : null;
    return selectSuccessorWindow(
      fs,
      { kind: 'attempt', id: staleOwner.attempt_id },
      (parent?.generation ?? 0) + 1,
    );
  }
  const windows = listWatchdogRecoveryWindows(fs);
  const latest = windows.at(-1);
  if (!latest) return { windowId: 'recovery-initial', generation: 0, expectedSeedVersion: 1 };
  if (latest.state === 'open' || latest.state === 'exhausted') {
    return { windowId: latest.windowId, generation: latest.generation };
  }
  return selectSuccessorWindow(
    fs,
    latest.winnerAttemptId
      ? { kind: 'attempt', id: latest.winnerAttemptId }
      : { kind: 'window', id: latest.windowId },
    latest.generation + 1,
  );
}

function samePredecessor(left: Predecessor, right: Predecessor): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function validateSelectedWindow(fs: FileSystem, selection: WindowSelection): void {
  const seed = readWindowSeed(fs, selection.windowId);
  if (seed.generation !== selection.generation) {
    throw new Error(`Recovery window generation mismatch: ${selection.windowId}`);
  }
  const predecessor = selection.predecessor;
  if (!predecessor) {
    if (selection.expectedSeedVersion && seed.schemaVersion !== selection.expectedSeedVersion) {
      throw new Error(`Recovery window seed version mismatch: ${selection.windowId}`);
    }
    return;
  }
  if (selection.windowId === legacySuccessorId(predecessor)) {
    if (seed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Invalid legacy recovery successor seed: ${selection.windowId}`);
    }
    return;
  }
  if (selection.windowId !== boundedSuccessorId(predecessor) ||
      seed.schemaVersion !== WINDOW_SEED_SCHEMA_VERSION ||
      !samePredecessor(seed.predecessor, predecessor)) {
    throw new Error(`Recovery successor identity mismatch: ${selection.windowId}`);
  }
}

function createWindow(
  fs: FileSystem,
  selection: WindowSelection,
  options: CandidateRecoveryOptions,
): WatchdogRecoveryWindow {
  const { windowId, generation, predecessor } = selection;
  const seed: WindowSeed = predecessor
    ? {
        schemaVersion: WINDOW_SEED_SCHEMA_VERSION,
        windowId,
        openedAtMs: options.nowMs ?? Date.now(),
        generation,
        budget: options.budget ?? WATCHDOG_CANDIDATE_BUDGET,
        state: 'open',
        predecessor,
      }
    : {
        schemaVersion: SCHEMA_VERSION,
        windowId,
        openedAtMs: options.nowMs ?? Date.now(),
        generation,
        budget: options.budget ?? WATCHDOG_CANDIDATE_BUDGET,
        state: 'open',
      };
  const staging = `${windowsDir()}/.opening-${newUuid()}`;
  fs.ensureDirSync(staging);
  fs.writeAtomicSync(`${staging}/${WINDOW_FILE}`, JSON.stringify(seed, null, 2));
  try {
    fs.moveDirSync(staging, windowDir(windowId));
  } catch (error) {
    try { fs.removeDirSync(staging); } catch { // silent: preserve the original commit error
    }
    const lostRenameRace = isExists(error) ||
      (isObject(error) && error.code === 'ENOTEMPTY');
    if (!lostRenameRace) throw error;
  }
  // A concurrent winner may have a different opening time or caller budget. Its
  // durable budget is authoritative, but identity and causal facts must agree.
  validateSelectedWindow(fs, selection);
  return inspectWatchdogRecoveryWindow(fs, windowId);
}

function writeRejection(
  fs: FileSystem,
  window: WatchdogRecoveryWindow,
  reason: 'budget_exhausted' | 'window_closed',
  attemptId: string,
): void {
  const rejection = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rejected',
    attemptId,
    windowId: window.windowId,
    reason,
    candidateCount: window.candidateCount,
    budget: window.budget,
    createdAt: new Date().toISOString(),
  };
  fs.writeAtomicSync(
    `${WATCHDOG_PATHS.recovery}/rejections/${window.windowId}/${attemptId}.json`,
    JSON.stringify(rejection, null, 2),
  );
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.CANDIDATE_REJECTED,
    `window=${window.windowId}`,
    `attempt=${attemptId}`,
    `reason=${reason}`,
    `candidate_count=${window.candidateCount}`,
    `budget=${window.budget}`,
  );
}

function rejected(
  fs: FileSystem,
  window: WatchdogRecoveryWindow,
  reason: 'budget_exhausted' | 'window_closed',
): WatchdogCandidateAdmissionResult {
  const attemptId = newUuid();
  writeRejection(fs, window, reason, attemptId);
  return { kind: 'rejected', reason, attemptId, windowId: window.windowId, window };
}

function newAttemptId(windowId: string, slot: number): string {
  const legacy = `${windowId}-candidate-${slot}`;
  if (Buffer.byteLength(legacy, 'utf8') <= 96) return legacy;
  return `ca2-${sha256Hex(JSON.stringify([windowId, slot]))}`;
}

function sameAdmission(left: WatchdogCandidateAdmission, right: WatchdogCandidateAdmission): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.attemptId === right.attemptId &&
    left.windowId === right.windowId &&
    left.slot === right.slot &&
    left.admittedAtMs === right.admittedAtMs &&
    left.callerPid === right.callerPid;
}

function mirrorCommittedAdmission(fs: FileSystem, admission: WatchdogCandidateAdmission): void {
  const mirror = `${candidateDir(admission.attemptId)}/${ADMISSION_FILE}`;
  let existing: WatchdogCandidateAdmission | null = null;
  try {
    existing = parseAdmission(fs.readSync(mirror));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing && !sameAdmission(existing, admission)) {
    throw new Error(`Candidate admission mirror conflict for attempt ${admission.attemptId}`);
  }
  fs.ensureDirSync(candidateDir(admission.attemptId));
  if (!existing) fs.writeAtomicSync(mirror, JSON.stringify(admission, null, 2));
}

/**
 * Atomically consume one fixed slot, then persist the candidate admission before
 * any spawn. A crash in either window leaves the committed slot consumed.
 */
export function admitWatchdogCandidate(
  fs: FileSystem,
  staleOwner: WindowOwnerFact | null,
  options: CandidateRecoveryOptions = {},
): WatchdogCandidateAdmissionResult {
  const selection = selectWindow(fs, staleOwner);
  let window = inspectWindowOrCreate(fs, selection, options);
  if (window.state === 'winner_committed' || window.state === 'closed') {
    return rejected(fs, window, 'window_closed');
  }
  if (window.state === 'exhausted') return rejected(fs, window, 'budget_exhausted');

  for (let slot = 0; slot < window.budget; slot++) {
    const admission: WatchdogCandidateAdmission = {
      schemaVersion: SCHEMA_VERSION,
      attemptId: newAttemptId(window.windowId, slot),
      windowId: window.windowId,
      slot,
      admittedAtMs: options.nowMs ?? Date.now(),
      callerPid: process.pid,
    };
    const staging = `${attemptsDir(window.windowId)}/.admitting-${newUuid()}`;
    fs.ensureDirSync(staging);
    fs.writeAtomicSync(`${staging}/${ADMISSION_FILE}`, JSON.stringify(admission, null, 2));
    try {
      fs.moveDirSync(staging, `${attemptsDir(window.windowId)}/${slot}`);
    } catch (error) {
      try { fs.removeDirSync(staging); } catch { // silent: preserve the original commit error
    }
      if (isExists(error) || fs.existsSync(`${attemptsDir(window.windowId)}/${slot}`)) continue;
      throw error;
    }

    // The permanent slot is the budget fact. Mirror its immutable identity into
    // the candidate directory before spawn for owner/outcome reconstruction.
    mirrorCommittedAdmission(fs, admission);
    window = inspectWatchdogRecoveryWindow(fs, window.windowId);
    if (window.state === 'winner_committed' || window.state === 'closed') {
      return rejected(fs, window, 'window_closed');
    }
    getAuditWriter()?.write(
      WATCHDOG_AUDIT_EVENTS.CANDIDATE_ADMITTED,
      `window=${admission.windowId}`,
      `attempt=${admission.attemptId}`,
      `slot=${slot}`,
      `candidate_count=${window.candidateCount}`,
      `budget=${window.budget}`,
    );
    return { kind: 'admitted', admission, window };
  }

  window = inspectWatchdogRecoveryWindow(fs, window.windowId);
  return rejected(fs, window, 'budget_exhausted');
}

function inspectWindowOrCreate(
  fs: FileSystem,
  selection: WindowSelection,
  options: CandidateRecoveryOptions,
): WatchdogRecoveryWindow {
  try {
    const window = inspectWatchdogRecoveryWindow(fs, selection.windowId);
    validateSelectedWindow(fs, selection);
    return window;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    assertWindowAbsent(fs, selection.windowId);
    if (selection.predecessor &&
        selection.windowId === legacySuccessorId(selection.predecessor)) {
      throw error;
    }
    return createWindow(fs, selection, options);
  }
}

/** Read the caller-committed identity consumed by a spawned child. */
export function readWatchdogCandidateAdmission(
  fs: FileSystem,
  attemptId: string,
): WatchdogCandidateAdmission {
  const admission = parseAdmission(fs.readSync(`${candidateDir(attemptId)}/${ADMISSION_FILE}`));
  if (admission.attemptId !== attemptId) {
    throw new Error(`Candidate admission identity mismatch: ${attemptId}`);
  }
  // The permanent slot must agree with the candidate mirror; a copied JSON file
  // alone is not admission authority.
  const committed = parseAdmission(fs.readSync(
    `${attemptsDir(admission.windowId)}/${admission.slot}/${ADMISSION_FILE}`,
  ));
  if (JSON.stringify(committed) !== JSON.stringify(admission)) {
    throw new Error(`Candidate admission was not committed for attempt ${attemptId}`);
  }
  return admission;
}

function findAttemptDir(fs: FileSystem, owner: WindowOwnerFact): string | null {
  if (!owner.recovery_window_id) return null;
  const admissions = readCommittedAdmissions(fs, owner.recovery_window_id);
  const admission = admissions.find((item) => item.attemptId === owner.attempt_id);
  return admission ? `${attemptsDir(admission.windowId)}/${admission.slot}` : null;
}

/** Persist actual child spawn evidence before the active rename. */
export function recordWatchdogCandidateSpawned(fs: FileSystem, owner: WindowOwnerFact): void {
  const attemptDir = findAttemptDir(fs, owner);
  if (!attemptDir) return;
  const outcome = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'spawned',
    attemptId: owner.attempt_id,
    windowId: owner.recovery_window_id,
    pid: owner.pid,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeExclusiveSync(`${attemptDir}/spawned.json`, JSON.stringify(outcome, null, 2));
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.CANDIDATE_SPAWNED,
    `window=${owner.recovery_window_id}`,
    `attempt=${owner.attempt_id}`,
    `pid=${owner.pid}`,
  );
}

/** Called only after candidate→active rename; active itself remains authoritative. */
export function recordWatchdogCandidateWinner(fs: FileSystem, owner: WindowOwnerFact): void {
  if (!owner.recovery_window_id) return;
  const winner = {
    schemaVersion: SCHEMA_VERSION,
    windowId: owner.recovery_window_id,
    attemptId: owner.attempt_id,
    ownerToken: owner.owner_token,
    pid: owner.pid,
    committedAt: new Date().toISOString(),
  };
  try {
    fs.writeExclusiveSync(
      `${windowDir(owner.recovery_window_id)}/${WINNER_FILE}`,
      JSON.stringify(winner, null, 2),
    );
  } catch (error) {
    if (!isExists(error)) {
      // The active rename has already committed. Preserve that fact and leave a
      // forensic error; summary reconstruction still infers it from active.
      getAuditWriter()?.write(
        WATCHDOG_AUDIT_EVENTS.CANDIDATE_WINDOW_EVIDENCE_FAILED,
        `window=${owner.recovery_window_id}`,
        `attempt=${owner.attempt_id}`,
        `error=${formatErr(error)}`,
      );
      return;
    }
  }
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.CANDIDATE_WINDOW_COMMITTED,
    `window=${owner.recovery_window_id}`,
    `attempt=${owner.attempt_id}`,
    `pid=${owner.pid}`,
  );
}

/** Winner retirement closes its epoch; late losers never reopen it. */
export function closeWatchdogCandidateWindow(
  fs: FileSystem,
  owner: WindowOwnerFact,
  reason: 'shutdown' | 'stale_recovery',
): void {
  if (!owner.recovery_window_id) return;
  const closed = {
    schemaVersion: SCHEMA_VERSION,
    windowId: owner.recovery_window_id,
    winnerAttemptId: owner.attempt_id,
    reason,
    closedAt: new Date().toISOString(),
  };
  try {
    fs.writeExclusiveSync(
      `${windowDir(owner.recovery_window_id)}/${CLOSED_FILE}`,
      JSON.stringify(closed, null, 2),
    );
  } catch (error) {
    if (!isExists(error)) {
      getAuditWriter()?.write(
        WATCHDOG_AUDIT_EVENTS.CANDIDATE_WINDOW_EVIDENCE_FAILED,
        `window=${owner.recovery_window_id}`,
        `attempt=${owner.attempt_id}`,
        `error=${formatErr(error)}`,
      );
      return;
    }
  }
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.CANDIDATE_WINDOW_CLOSED,
    `window=${owner.recovery_window_id}`,
    `attempt=${owner.attempt_id}`,
    `reason=${reason}`,
  );
}
