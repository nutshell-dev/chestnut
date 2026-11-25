/**
 * @module L6.Watchdog.Ownership
 * @layer L6 进程边界（Watchdog 守护进程）
 * @depends L1.FileSystem, L1.ProcessExec, L2.AuditLog
 * @contract design/modules/l6_watchdog.md §1.1 Invariant 2（Phase 1203）
 *
 * Watchdog 目录位置 ownership 状态机：
 *   candidates/<attempt-id>/  →（move 整个非空目录）→  active/
 *   active/                   →（move 到 token-specific 永久非空目录）→  retired/<owner-token>/
 *
 * 目录位置是 generation 状态 SoT（M#4 磁盘即权威）；进程内 Promise 与 caller 锁
 * 均非 authority。destination 已存在且非空时 rename 必失败 —— 这是防迟到
 * reclaimer 覆盖 fresh generation 的必要条件（反向测试先证、不只靠 mock）。
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr, newUuid } from '../foundation/node-utils/index.js';
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import {
  captureOwnedProcessRef,
  _captureProcessRefForTest,
  type ProcessRefCapture,
} from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import type { WatchdogProcessDeps } from './types.js';
import { WATCHDOG_PATHS } from './layout.js';
import { getAuditWriter } from './watchdog-context.js';
import {
  closeWatchdogCandidateWindow,
  readWatchdogCandidateAdmission,
  recordWatchdogCandidateWinner,
} from './candidate-recovery.js';

const WATCHDOG_OWNERSHIP_SCHEMA_VERSION = 2;
const WATCHDOG_LEGACY_OWNERSHIP_SCHEMA_VERSION = 1;

// Phase 1287 Step B: 目录常量归 layout 协议唯一 owner；此处保留兼容导出
// 名称（测试与内部调用契约），仅从 WATCHDOG_PATHS 派生、不再重复字面。
export const WATCHDOG_OWNERSHIP_DIR = WATCHDOG_PATHS.root;
export const WATCHDOG_CANDIDATES_DIR = WATCHDOG_PATHS.candidates;
export const WATCHDOG_ACTIVE_DIR = WATCHDOG_PATHS.active;
export const WATCHDOG_RETIRED_DIR = WATCHDOG_PATHS.retired;
const WATCHDOG_OWNER_FILE = 'owner.json';
const WATCHDOG_OUTCOME_FILE = 'outcome.json';
export const WATCHDOG_TERMINAL_FILE = 'terminal.json';

/**
 * Phase 1930 Step B：Watchdog 磁盘记录（schema1 `workspace_root` / legacy
 * `watchdog.pid` root）的语义是**实例父目录**（旧 CHESTNUT_ROOT 含义），
 * 磁盘协议保持不变——写入仍存父目录。本组 helper 是该兼容格式的唯一私有
 * 适配点：跨模块只传 ChestnutRoot，比较一律转成实例身份，不散落不同算法。
 */

/** 当前实例的 legacy 父目录身份（写入 / 错误展示用；恒为绝对规范路径）。 */
export function currentLegacyParentRoot(): string {
  return path.dirname(getChestnutRoot());
}

/**
 * 私有适配：磁盘记录的父目录是否对应当前实例。
 * 绝对记录归一化后比较实例身份；相对历史记录缺原 cwd 证据，明确失败
 * （fail-closed），不猜当前 cwd、不回写磁盘。
 */
export function legacyParentMatchesInstance(recordRoot: string): boolean {
  if (!path.isAbsolute(recordRoot)) {
    throw new Error(
      `watchdog record holds a relative workspace root ${JSON.stringify(recordRoot)}; ` +
      `original cwd evidence is lost — refusing to guess it, resolve the record manually`,
    );
  }
  return path.resolve(recordRoot, '.chestnut') === getChestnutRoot();
}

// === Records ===

interface WatchdogOwnerRecordBase {
  attempt_id: string;
  owner_token: string;
  /** Display/generation metadata only; ProcessRef is the persisted OS identity. */
  pid: number;
  /** Present only for candidates admitted through a persistent recovery window. */
  recovery_window_id?: string;
  workspace_root: string;
  created_at: string;
}

export interface WatchdogOwnerRecordV2 extends WatchdogOwnerRecordBase {
  schema_version: 2;
  /** Opaque L1 ProcessRef. Watchdog never parses or brands this value. */
  process_ref: string;
}

export interface WatchdogLegacyOwnerRecord extends WatchdogOwnerRecordBase {
  schema_version: 1;
  process_start_time: string;
}

export type WatchdogOwnerRecord = WatchdogOwnerRecordV2 | WatchdogLegacyOwnerRecord;

interface WatchdogOutcomeRecord {
  schema_version: number;
  attempt_id: string;
  outcome: 'lost' | 'failed';
  window_id?: string;
  winner_owner_token?: string;
  winner_attempt_id?: string;
  winner_pid?: number;
  reason: string;
  created_at: string;
}

function isOwnerRecord(parsed: unknown): parsed is WatchdogOwnerRecord {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<Record<string, unknown>>;
  const common = (
    typeof p.attempt_id === 'string' && p.attempt_id.length > 0 &&
    typeof p.owner_token === 'string' && p.owner_token.length > 0 &&
    typeof p.pid === 'number' &&
    typeof p.workspace_root === 'string' &&
    typeof p.created_at === 'string'
  );
  if (!common || ('recovery_window_id' in p && typeof p.recovery_window_id !== 'string')) return false;
  if (p.schema_version === WATCHDOG_OWNERSHIP_SCHEMA_VERSION) {
    return typeof p.process_ref === 'string' && p.process_ref.length > 0;
  }
  return p.schema_version === WATCHDOG_LEGACY_OWNERSHIP_SCHEMA_VERSION
    && typeof p.process_start_time === 'string';
}

// === Typed outcomes ===

export interface WatchdogOwnership {
  attemptId: string;
  ownerToken: string;
  pid: number;
  /** relative active dir（commit 后唯一可写路径；caller 不得再用旧 candidate 路径） */
  activeDir: string;
  record: WatchdogOwnerRecord;
}

type CommitOwnership =
  | { kind: 'committed'; ownership: WatchdogOwnership }
  | { kind: 'already_owned'; owner: WatchdogOwnerRecord }
  | { kind: 'foreign_owned'; owner: WatchdogOwnerRecord }
  | { kind: 'retryable_failure'; attemptId: string; cause: unknown };

type ActiveInspection =
  | { status: 'none' }
  | { status: 'ok'; owner: WatchdogOwnerRecord }
  | { status: 'malformed'; cause: unknown };

type RetireOwnership =
  | { kind: 'retired'; owner: WatchdogOwnerRecord }
  | { kind: 'no_active' }
  | { kind: 'mismatch'; owner: WatchdogOwnerRecord }
  | { kind: 'malformed_active'; cause: unknown }
  | { kind: 'collision'; owner: WatchdogOwnerRecord }
  | { kind: 'retryable_failure'; cause: unknown };

// === Generation terminal (Phase 1247 Step B) ===

export type WatchdogGenerationTerminal =
  | { kind: 'stopped'; signal: 'SIGTERM' | 'SIGINT'; recorded_at: string }
  | { kind: 'crashed'; reason: string; recorded_at: string }
  | { kind: 'unclean'; detected_at: string; detected_by_pid: number };

export type RecordTerminalResult =
  | { kind: 'recorded'; terminal: WatchdogGenerationTerminal }
  | { kind: 'already_recorded'; terminal: WatchdogGenerationTerminal }
  | { kind: 'no_active' }
  | { kind: 'mismatch' }
  | { kind: 'malformed'; cause: unknown }
  | { kind: 'failed'; cause: unknown };

type TerminalInspection =
  | { status: 'none' }
  | { status: 'ok'; terminal: WatchdogGenerationTerminal }
  | { status: 'malformed'; cause: unknown };

function isTerminalRecord(parsed: unknown): parsed is WatchdogGenerationTerminal {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<WatchdogGenerationTerminal> & Record<string, unknown>;
  if (p.kind !== 'stopped' && p.kind !== 'crashed' && p.kind !== 'unclean') return false;
  if (typeof p.recorded_at !== 'string' && typeof p.detected_at !== 'string') return false;
  if (p.kind === 'stopped') {
    return (
      typeof p.recorded_at === 'string' &&
      (p.signal === 'SIGTERM' || p.signal === 'SIGINT')
    );
  }
  if (p.kind === 'crashed') {
    return (
      typeof p.recorded_at === 'string' &&
      typeof p.reason === 'string'
    );
  }
  // unclean
  return (
    typeof p.detected_at === 'string' &&
    typeof p.detected_by_pid === 'number'
  );
}

// === Attempt preparation ===

export class WatchdogProcessRefCaptureError extends Error {
  constructor(readonly capture: Exclude<ProcessRefCapture, { kind: 'captured' }>) {
    super(`Cannot persist watchdog owner without a captured ProcessRef: ${capture.kind}`);
    this.name = 'WatchdogProcessRefCaptureError';
  }
}

function captureAttemptIdentity(pid: number, deps?: WatchdogProcessDeps): ProcessRefCapture {
  const captured = (deps?.captureOwnedProcessRef ?? captureOwnedProcessRef)(pid);
  if (captured.kind === 'captured' || process.env.NODE_ENV !== 'test'
      || !Number.isSafeInteger(pid) || pid <= 0) {
    return captured;
  }
  // Explicit fake-PID test seam. Real production captures never take this branch.
  return _captureProcessRefForTest(pid);
}

/** 生成一次 startup attempt 的完整 record（写 candidate 前的事实全集）。 */
export function newWatchdogAttempt(
  pid: number = process.pid,
  deps?: WatchdogProcessDeps,
): WatchdogOwnerRecordV2 {
  const identity = captureAttemptIdentity(pid, deps);
  if (identity.kind !== 'captured') throw new WatchdogProcessRefCaptureError(identity);
  return {
    schema_version: WATCHDOG_OWNERSHIP_SCHEMA_VERSION,
    attempt_id: newUuid(),
    owner_token: newUuid(),
    pid,
    process_ref: identity.value,
    workspace_root: currentLegacyParentRoot(),
    created_at: new Date().toISOString(),
  };
}

function candidateDir(attemptId: string): string {
  return `${WATCHDOG_CANDIDATES_DIR}/${attemptId}`;
}

/**
 * 在私有 candidate 目录完整写入 `owner.json` 并持久化。
 * candidate 即完整 startup 事实（DP1/DP5）：commit 前崩溃也留有证据。
 */
export function prepareCandidate(fs: FileSystem, record: WatchdogOwnerRecord): void {
  const dir = candidateDir(record.attempt_id);
  fs.ensureDirSync(dir);
  fs.writeAtomicSync(`${dir}/${WATCHDOG_OWNER_FILE}`, JSON.stringify(record, null, 2));
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.OWNERSHIP_ATTEMPTED,
    `attempt=${record.attempt_id}`,
    `pid=${record.pid}`,
  );
}

// === Active inspection ===

/** 读 active owner；不猜错误码 —— 读不到/畸形都显式分型。 */
export function inspectActive(fs: FileSystem): ActiveInspection {
  let content: string;
  try {
    content = fs.readSync(`${WATCHDOG_ACTIVE_DIR}/${WATCHDOG_OWNER_FILE}`);
  } catch (err) {
    if (isFsNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  return parseOwner(content);
}

function parseOwner(content: string): ActiveInspection {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isOwnerRecord(parsed)) return { status: 'malformed', cause: 'owner_shape_mismatch' };
    return { status: 'ok', owner: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
}

function isFsNotFound(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'FS_NOT_FOUND';
  }
  return false;
}

export interface WatchdogGenerationRecord {
  generation: 'active' | 'candidate' | 'retired';
  owner: WatchdogOwnerRecord;
  candidateOutcome: 'lost' | 'failed' | null;
}

export type WatchdogGenerationRecordsInspection =
  | { kind: 'ok'; records: readonly WatchdogGenerationRecord[] }
  | { kind: 'unknown'; reason: string; error?: unknown };

function readGenerationOwner(
  fs: FileSystem,
  ownerPath: string,
  generation: WatchdogGenerationRecord['generation'],
  candidateOutcome: WatchdogGenerationRecord['candidateOutcome'],
): WatchdogGenerationRecord {
  const parsed: unknown = JSON.parse(fs.readSync(ownerPath));
  if (!isOwnerRecord(parsed)) throw new Error(`owner_shape_mismatch:${ownerPath}`);
  return { generation, owner: parsed, candidateOutcome };
}

function readCandidateOutcome(fs: FileSystem, dir: string): 'lost' | 'failed' | null {
  try {
    const parsed = JSON.parse(fs.readSync(`${dir}/${WATCHDOG_OUTCOME_FILE}`)) as {
      outcome?: unknown;
    };
    if (parsed.outcome !== 'lost' && parsed.outcome !== 'failed') {
      throw new Error(`candidate_outcome_shape_mismatch:${dir}`);
    }
    return parsed.outcome;
  } catch (err) {
    if (isFsNotFound(err)) return null;
    throw err;
  }
}

/** Read every generation through the ownership schema owner; never infer identity from argv alone. */
export function inspectWatchdogGenerationRecords(
  fs: FileSystem,
): WatchdogGenerationRecordsInspection {
  const records: WatchdogGenerationRecord[] = [];
  try {
    const active = inspectActive(fs);
    if (active.status === 'malformed') {
      return { kind: 'unknown', reason: 'generation_malformed', error: active.cause };
    }
    if (active.status === 'ok') {
      records.push({ generation: 'active', owner: active.owner, candidateOutcome: null });
    }
    for (const generation of ['candidates', 'retired'] as const) {
      const root = generation === 'candidates' ? WATCHDOG_CANDIDATES_DIR : WATCHDOG_RETIRED_DIR;
      let entries;
      try {
        entries = fs.listSync(root, { includeDirs: true });
      } catch (err) {
        if (isFsNotFound(err)) {
          // silent: an absent generation directory contains no records
          continue;
        }
        throw err;
      }
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const dir = `${root}/${entry.name}`;
        records.push(readGenerationOwner(
          fs,
          `${dir}/${WATCHDOG_OWNER_FILE}`,
          generation === 'candidates' ? 'candidate' : 'retired',
          generation === 'candidates' ? readCandidateOutcome(fs, dir) : null,
        ));
      }
    }
    return { kind: 'ok', records };
  } catch (error) {
    // silent: converted below to typed unknown with the original error evidence
    return { kind: 'unknown', reason: 'generation_malformed', error };
  }
}

function isFsExists(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EEXIST';
  }
  return false;
}

/**
 * 读取 winner generation 的 terminal 终局。
 * terminal 只存在于 active/retired 的 generation 目录内，candidate outcome 不是 terminal。
 */
function parseTerminal(content: string): TerminalInspection {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isTerminalRecord(parsed)) return { status: 'malformed', cause: 'terminal_shape_mismatch' };
    return { status: 'ok', terminal: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
}

export function inspectTerminal(fs: FileSystem): TerminalInspection {
  let content: string;
  try {
    content = fs.readSync(`${WATCHDOG_ACTIVE_DIR}/${WATCHDOG_TERMINAL_FILE}`);
  } catch (err) {
    if (isFsNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  return parseTerminal(content);
}

export type WatchdogAttemptTerminalInspection =
  | { kind: 'none' }
  | { kind: 'terminal'; terminal: WatchdogGenerationTerminal }
  | { kind: 'unknown'; reason: string; error?: unknown };

function readTerminalForAttempt(fs: FileSystem, dir: string): WatchdogAttemptTerminalInspection {
  let content: string;
  try {
    content = fs.readSync(`${dir}/${WATCHDOG_TERMINAL_FILE}`);
  } catch (err) {
    if (isFsNotFound(err)) return { kind: 'none' };
    return { kind: 'unknown', reason: 'terminal_read_failed', error: formatErr(err) };
  }
  const inspection = parseTerminal(content);
  if (inspection.status === 'ok') return { kind: 'terminal', terminal: inspection.terminal };
  return {
    kind: 'unknown',
    reason: 'terminal_malformed',
    error: inspection.status === 'malformed' ? inspection.cause : 'terminal_read_failed',
  };
}

function inspectExactRetiredTerminal(
  fs: FileSystem,
  attemptId: string,
  ownerToken: string,
): WatchdogAttemptTerminalInspection {
  const dir = `${WATCHDOG_RETIRED_DIR}/${ownerToken}`;
  let content: string;
  try {
    content = fs.readSync(`${dir}/${WATCHDOG_OWNER_FILE}`);
  } catch (err) {
    if (isFsNotFound(err)) return { kind: 'none' };
    return { kind: 'unknown', reason: 'retired_owner_read_failed', error: formatErr(err) };
  }
  const inspection = parseOwner(content);
  if (inspection.status !== 'ok') {
    return {
      kind: 'unknown',
      reason: 'retired_owner_malformed',
      error: inspection.status === 'malformed' ? inspection.cause : 'retired_owner_missing',
    };
  }
  if (inspection.owner.attempt_id !== attemptId || inspection.owner.owner_token !== ownerToken) {
    return { kind: 'unknown', reason: 'retired_owner_mismatch' };
  }
  return readTerminalForAttempt(fs, dir);
}

function inspectRetiredTerminalForAttempt(
  fs: FileSystem,
  attemptId: string,
): WatchdogAttemptTerminalInspection {
  let entries;
  try {
    entries = fs.listSync(WATCHDOG_RETIRED_DIR, { includeDirs: true });
  } catch (err) {
    if (isFsNotFound(err)) return { kind: 'none' };
    return { kind: 'unknown', reason: 'retired_list_failed', error: formatErr(err) };
  }
  let match: { dir: string; owner: WatchdogOwnerRecord } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const dir = `${WATCHDOG_RETIRED_DIR}/${entry.name}`;
    let content: string;
    try {
      content = fs.readSync(`${dir}/${WATCHDOG_OWNER_FILE}`);
    } catch (err) {
      return {
        kind: 'unknown',
        reason: isFsNotFound(err) ? 'retired_owner_missing' : 'retired_owner_read_failed',
        error: formatErr(err),
      };
    }
    const inspection = parseOwner(content);
    if (inspection.status !== 'ok') {
      return {
        kind: 'unknown',
        reason: 'retired_owner_malformed',
        error: inspection.status === 'malformed' ? inspection.cause : 'retired_owner_missing',
      };
    }
    if (inspection.owner.attempt_id !== attemptId) continue;
    if (entry.name !== inspection.owner.owner_token) {
      return { kind: 'unknown', reason: 'retired_owner_token_mismatch' };
    }
    if (match !== null) return { kind: 'unknown', reason: 'multiple_retired_matches' };
    match = { dir, owner: inspection.owner };
  }
  return match === null ? { kind: 'none' } : readTerminalForAttempt(fs, match.dir);
}

/** Read only the terminal bound to this startup attempt; never fall back to a latest generation. */
export function inspectTerminalForAttempt(
  fs: FileSystem,
  attemptId: string,
): WatchdogAttemptTerminalInspection {
  const active = inspectActive(fs);
  if (active.status === 'malformed') {
    return { kind: 'unknown', reason: 'active_owner_malformed', error: active.cause };
  }
  if (active.status !== 'ok' || active.owner.attempt_id !== attemptId) {
    return inspectRetiredTerminalForAttempt(fs, attemptId);
  }

  const ownerToken = active.owner.owner_token;
  const terminal = readTerminalForAttempt(fs, WATCHDOG_ACTIVE_DIR);
  const recheck = inspectActive(fs);
  if (
    recheck.status === 'ok' &&
    recheck.owner.attempt_id === attemptId &&
    recheck.owner.owner_token === ownerToken
  ) {
    return terminal;
  }

  const retired = inspectExactRetiredTerminal(fs, attemptId, ownerToken);
  if (retired.kind !== 'none' || recheck.status !== 'malformed') return retired;
  return { kind: 'unknown', reason: 'active_owner_malformed', error: recheck.cause };
}

function terminalTimeMs(terminal: WatchdogGenerationTerminal): number {
  return Date.parse(terminal.kind === 'unclean' ? terminal.detected_at : terminal.recorded_at);
}

/** Read the newest retired terminal without exposing the generation layout to callers. */
export function inspectLatestRetiredTerminal(fs: FileSystem): TerminalInspection {
  let entries;
  try {
    entries = fs.listSync(WATCHDOG_RETIRED_DIR, { includeDirs: true });
  } catch (err) {
    if (isFsNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  let latest: WatchdogGenerationTerminal | null = null;
  let latestMs = -Infinity;
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    let content: string;
    try {
      content = fs.readSync(`${WATCHDOG_RETIRED_DIR}/${entry.name}/${WATCHDOG_TERMINAL_FILE}`);
    } catch (err) {
      if (isFsNotFound(err)) continue;
      return { status: 'malformed', cause: formatErr(err) };
    }
    const inspected = parseTerminal(content);
    if (inspected.status !== 'ok') {
      return inspected.status === 'malformed'
        ? inspected
        : { status: 'malformed', cause: 'terminal_read_failed' };
    }
    const atMs = terminalTimeMs(inspected.terminal);
    if (!Number.isFinite(atMs)) return { status: 'malformed', cause: 'terminal_timestamp_invalid' };
    if (atMs > latestMs) {
      latest = inspected.terminal;
      latestMs = atMs;
    }
  }
  return latest === null ? { status: 'none' } : { status: 'ok', terminal: latest };
}

/**
 * 为当前 active winner generation 写 terminal 终局。
 * - 先 generation-guard 匹配 active owner（attempt/token/pid）；
 * - 用 exclusive 写保证 first terminal wins，已存在 terminal 时保留原事实；
 * - 写失败返回 typed failure，caller 不得继续退役成“无证据”。
 */
export function recordGenerationTerminal(
  fs: FileSystem,
  expected: { attemptId: string; ownerToken: string; pid: number },
  terminal: WatchdogGenerationTerminal,
): RecordTerminalResult {
  const inspection = inspectActive(fs);
  if (inspection.status === 'none') return { kind: 'no_active' };
  if (inspection.status === 'malformed') return { kind: 'malformed', cause: inspection.cause };
  const owner = inspection.owner;
  if (
    owner.attempt_id !== expected.attemptId ||
    owner.owner_token !== expected.ownerToken ||
    owner.pid !== expected.pid
  ) {
    return { kind: 'mismatch' };
  }
  const terminalPath = `${WATCHDOG_ACTIVE_DIR}/${WATCHDOG_TERMINAL_FILE}`;
  try {
    fs.writeExclusiveSync(terminalPath, JSON.stringify(terminal, null, 2));
    return { kind: 'recorded', terminal };
  } catch (err) {
    if (isFsExists(err)) {
      try {
        const existing = inspectTerminal(fs);
        if (existing.status === 'ok') return { kind: 'already_recorded', terminal: existing.terminal };
        return { kind: 'malformed', cause: existing.status === 'malformed' ? existing.cause : 'terminal_read_failed' };
      } catch (readErr) {
        return { kind: 'malformed', cause: formatErr(readErr) };
      }
    }
    return { kind: 'failed', cause: formatErr(err) };
  }
}

// === Commit (candidate → active) ===

/**
 * 将整个非空 candidate 目录 move 到固定 `watchdog/active`。
 * destination 不存在时恰好一个 rename 成功；collision 后重读 active 形成
 * typed outcome（不从错误码猜 owner）。畸形 active fail-closed 并 audit。
 */
export function commitOwnership(fs: FileSystem, record: WatchdogOwnerRecord): CommitOwnership {
  const src = candidateDir(record.attempt_id);
  try {
    fs.moveDirSync(src, WATCHDOG_ACTIVE_DIR);
  } catch (moveErr) {
    return resolveCommitCollision(fs, record, formatErr(moveErr));
  }
  // The active rename above is authoritative. The marker makes the recovery
  // epoch durable; if this write crashes, summaries reconstruct from active.
  recordWatchdogCandidateWinner(fs, record);
  const ownership: WatchdogOwnership = {
    attemptId: record.attempt_id,
    ownerToken: record.owner_token,
    pid: record.pid,
    activeDir: WATCHDOG_ACTIVE_DIR,
    record,
  };
  getAuditWriter()?.write(
    WATCHDOG_AUDIT_EVENTS.OWNERSHIP_COMMITTED,
    `attempt=${record.attempt_id}`,
    `token=${record.owner_token}`,
    `pid=${record.pid}`,
  );
  return { kind: 'committed', ownership };
}

function resolveCommitCollision(fs: FileSystem, record: WatchdogOwnerRecord, moveErr: unknown): CommitOwnership {
  const inspection = inspectActive(fs);
  const auditWriter = getAuditWriter();
  if (inspection.status === 'ok') {
    const owner = inspection.owner;
    if (owner.attempt_id === record.attempt_id && owner.owner_token === record.owner_token) {
      // 本 attempt 前次 commit 已成功但结果丢失（崩溃窗口）→ 幂等收敛
      return { kind: 'already_owned', owner };
    }
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.OWNERSHIP_LOST,
      `attempt=${record.attempt_id}`,
      `winner_attempt=${owner.attempt_id}`,
      `winner_pid=${owner.pid}`,
    );
    return { kind: 'foreign_owned', owner };
  }
  if (inspection.status === 'malformed') {
    // 畸形 active：fail-closed，不覆盖、不猜 owner
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.OWNERSHIP_MALFORMED_ACTIVE,
      `attempt=${record.attempt_id}`,
      `error=${auditWriter?.message(formatErr(inspection.cause)) ?? formatErr(inspection.cause)}`,
    );
    return { kind: 'retryable_failure', attemptId: record.attempt_id, cause: inspection.cause };
  }
  // move 失败但 active 不存在 = 瞬时 IO 故障（source 仍在 candidate）
  return { kind: 'retryable_failure', attemptId: record.attempt_id, cause: moveErr };
}

/**
 * loser/failure 在自己的 candidate 写 immutable outcome（exclusive 单次写）。
 * 只对仍是 candidate 的目录调用 —— winner 目录已整体移走，caller 不得用旧路径。
 */
export function writeCandidateOutcome(
  fs: FileSystem,
  attemptId: string,
  outcome: Omit<WatchdogOutcomeRecord, 'schema_version' | 'attempt_id' | 'created_at'>,
): void {
  const admissionPath = `${candidateDir(attemptId)}/admission.json`;
  const admission = fs.existsSync(admissionPath)
    ? readWatchdogCandidateAdmission(fs, attemptId)
    : null;
  const record: WatchdogOutcomeRecord = {
    schema_version: WATCHDOG_OWNERSHIP_SCHEMA_VERSION,
    attempt_id: attemptId,
    created_at: new Date().toISOString(),
    ...(admission ? { window_id: admission.windowId } : {}),
    ...outcome,
  };
  fs.writeExclusiveSync(
    `${candidateDir(attemptId)}/${WATCHDOG_OUTCOME_FILE}`,
    JSON.stringify(record, null, 2),
  );
}

// === Retire (active → retired/<owner-token>) ===

/**
 * shutdown / stale recovery 将整个 active 目录 move 到由 owner token 稳定派生的
 * `retired/<owner-token>`。retire 前 fresh-read active 并要求 attempt/token/pid
 * 全匹配；destination 已存在（非空）时 rename 必失败 → 迟到 reclaimer 不能
 * 移动 fresh generation。
 */
export function retireOwnership(
  fs: FileSystem,
  expected: { attemptId: string; ownerToken: string; pid: number },
  reason: 'shutdown' | 'stale_recovery',
): RetireOwnership {
  const inspection = inspectActive(fs);
  const auditWriter = getAuditWriter();
  if (inspection.status === 'none') return { kind: 'no_active' };
  if (inspection.status === 'malformed') {
    auditWriter?.write(
      WATCHDOG_AUDIT_EVENTS.OWNERSHIP_MALFORMED_ACTIVE,
      `ctx=retire`,
      `reason=${reason}`,
      `error=${auditWriter?.message(formatErr(inspection.cause)) ?? formatErr(inspection.cause)}`,
    );
    return { kind: 'malformed_active', cause: inspection.cause };
  }
  const owner = inspection.owner;
  if (
    owner.attempt_id !== expected.attemptId ||
    owner.owner_token !== expected.ownerToken ||
    owner.pid !== expected.pid
  ) {
    // 旧 generation 迟到 shutdown/reclaim：不动 fresh active
    return { kind: 'mismatch', owner };
  }
  const retiredDest = `${WATCHDOG_RETIRED_DIR}/${owner.owner_token}`;
  if (fs.existsSync(retiredDest)) {
    // 另一 reclaimer 已处置该 generation；destination 永久非空、不可覆盖
    return { kind: 'collision', owner };
  }
  try {
    fs.moveDirSync(WATCHDOG_ACTIVE_DIR, retiredDest);
  } catch (moveErr) {
    if (fs.existsSync(retiredDest)) return { kind: 'collision', owner };
    return { kind: 'retryable_failure', cause: formatErr(moveErr) };
  }
  auditWriter?.write(
    WATCHDOG_AUDIT_EVENTS.OWNERSHIP_RETIRED,
    `attempt=${owner.attempt_id}`,
    `token=${owner.owner_token}`,
    `pid=${owner.pid}`,
    `reason=${reason}`,
  );
  closeWatchdogCandidateWindow(fs, owner, reason);
  return { kind: 'retired', owner };
}
