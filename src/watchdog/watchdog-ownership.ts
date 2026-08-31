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

import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr, newUuid } from '../foundation/node-utils/index.js';
import { getWorkspaceRoot } from '../core/claw-topology/index.js';
import { getProcessStartTime } from '../foundation/process-exec/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { WATCHDOG_PATHS } from './layout.js';
import { getAuditWriter } from './watchdog-context.js';

const WATCHDOG_OWNERSHIP_SCHEMA_VERSION = 1;

// Phase 1287 Step B: 目录常量归 layout 协议唯一 owner；此处保留兼容导出
// 名称（测试与内部调用契约），仅从 WATCHDOG_PATHS 派生、不再重复字面。
export const WATCHDOG_OWNERSHIP_DIR = WATCHDOG_PATHS.root;
export const WATCHDOG_CANDIDATES_DIR = WATCHDOG_PATHS.candidates;
export const WATCHDOG_ACTIVE_DIR = WATCHDOG_PATHS.active;
export const WATCHDOG_RETIRED_DIR = WATCHDOG_PATHS.retired;
const WATCHDOG_OWNER_FILE = 'owner.json';
const WATCHDOG_OUTCOME_FILE = 'outcome.json';
export const WATCHDOG_TERMINAL_FILE = 'terminal.json';

// === Records ===

export interface WatchdogOwnerRecord {
  schema_version: number;
  attempt_id: string;
  owner_token: string;
  pid: number;
  process_start_time: string;
  workspace_root: string;
  created_at: string;
}

export interface WatchdogOutcomeRecord {
  schema_version: number;
  attempt_id: string;
  outcome: 'lost' | 'failed';
  winner_owner_token?: string;
  winner_pid?: number;
  reason: string;
  created_at: string;
}

function isOwnerRecord(parsed: unknown): parsed is WatchdogOwnerRecord {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<WatchdogOwnerRecord>;
  return (
    p.schema_version === WATCHDOG_OWNERSHIP_SCHEMA_VERSION &&
    typeof p.attempt_id === 'string' && p.attempt_id.length > 0 &&
    typeof p.owner_token === 'string' && p.owner_token.length > 0 &&
    typeof p.pid === 'number' &&
    typeof p.process_start_time === 'string' &&
    typeof p.workspace_root === 'string' &&
    typeof p.created_at === 'string'
  );
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

type RecordTerminalResult =
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

/** 生成一次 startup attempt 的完整 record（写 candidate 前的事实全集）。 */
export function newWatchdogAttempt(pid: number = process.pid): WatchdogOwnerRecord {
  return {
    schema_version: WATCHDOG_OWNERSHIP_SCHEMA_VERSION,
    attempt_id: newUuid(),
    owner_token: newUuid(),
    pid,
    process_start_time: getProcessStartTime(pid) ?? 'unknown',
    workspace_root: getWorkspaceRoot(),
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
export function inspectTerminal(fs: FileSystem): TerminalInspection {
  let content: string;
  try {
    content = fs.readSync(`${WATCHDOG_ACTIVE_DIR}/${WATCHDOG_TERMINAL_FILE}`);
  } catch (err) {
    if (isFsNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isTerminalRecord(parsed)) return { status: 'malformed', cause: 'terminal_shape_mismatch' };
    return { status: 'ok', terminal: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
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
  const record: WatchdogOutcomeRecord = {
    schema_version: WATCHDOG_OWNERSHIP_SCHEMA_VERSION,
    attempt_id: attemptId,
    created_at: new Date().toISOString(),
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
  return { kind: 'retired', owner };
}
