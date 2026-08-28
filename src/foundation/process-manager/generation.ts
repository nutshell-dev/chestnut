/**
 * @module L2a.ProcessManager.Generation
 * Process generation directory store (Phase 1204 Step A).
 *
 * 目录位置状态机（design/modules/l2_process_manager.md §1.4 invariant 5，
 * drift A.phase1204-process-directory-lifecycle）：
 *
 *   status/process/candidates/<generation-id>/generation.json
 *        │ parent commit（move 整个非空目录）
 *        ▼
 *   status/process/spawning/
 *        ├── generation.json
 *        └── pid.json              parent 写真实 child PID + startTime
 *        │ child Assembly + ready 事实完成后 move
 *        ▼
 *   status/process/active/
 *        ├── generation.json
 *        ├── pid.json
 *        └── ready.json
 *        │ shutdown / confirmed-dead / failed move
 *        ▼
 *   status/process/retired/<generation-id>/
 *
 * 目录位置 + generation record 是 daemon generation 的唯一 SoT（M#4 磁盘即
 * 权威）；不持内存 owner token、不用 lease / timeout。move collision 后重读
 * 真实位置形成 discriminated outcome，不从异常猜 winner（同 Phase 1203
 * watchdog-ownership 协议形态）。destination 已存在且非空时 rename 必失败 ——
 * 这是迟到 reclaimer 不能覆盖 fresh generation 的必要条件。
 */

import * as path from 'path';
import { formatErr, newUuid } from '../node-utils/index.js';
import { isFileNotFound } from '../fs/index.js';
import {
  getProcessStartTime as defaultGetProcessStartTime,
  type ProcessStartTime,
} from '../process-exec/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from './audit-events.js';
import { STATUS_SUBDIR } from './paths.js';
import type { DaemonDir, ProcessManagerContext } from './types.js';

export const PROCESS_GENERATION_SCHEMA_VERSION = 1;

const PROCESS_DIR_NAME = 'process';
const CANDIDATES_DIR_NAME = 'candidates';
export const SPAWNING_DIR_NAME = 'spawning';
export const ACTIVE_DIR_NAME = 'active';
export const RETIRED_DIR_NAME = 'retired';
export const STOP_INTENTS_DIR_NAME = 'stop-intents';

export const GENERATION_FILE = 'generation.json';
export const PID_FILE = 'pid.json';
export const READY_FILE = 'ready.json';
export const FAILURE_FILE = 'failure.json';

/**
 * child env 携带的 generation identity（CHESTNUT_* 落 process-exec env-scrub
 * allowlist）。跨进程交接必须显式传 generation ID，child 不得扫描猜测。
 */
export const PROCESS_GENERATION_ENV = 'CHESTNUT_PROCESS_GENERATION';

// === Records ===

export interface ProcessGenerationRecord {
  schema_version: number;
  generation_id: string;
  daemon_dir: string;
  parent_pid: number;
  parent_start_time?: string;
  created_at: string;
}

export interface ProcessPidRecord {
  schema_version: number;
  generation_id: string;
  pid: number;
  start_time?: string;
  created_at: string;
}

/** ready 事实与 pid 同形：child 在 spawning 内写好后随目录整体 move 进 active（单 SoT）。 */
export type ProcessReadyRecord = ProcessPidRecord;

export interface ProcessFailureRecord {
  schema_version: number;
  generation_id: string;
  reason: string;
  created_at: string;
}

function isValidPid(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function isGenerationRecord(parsed: unknown): parsed is ProcessGenerationRecord {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<ProcessGenerationRecord>;
  return (
    p.schema_version === PROCESS_GENERATION_SCHEMA_VERSION &&
    typeof p.generation_id === 'string' && p.generation_id.length > 0 &&
    typeof p.daemon_dir === 'string' && p.daemon_dir.length > 0 &&
    isValidPid(p.parent_pid) &&
    (p.parent_start_time === undefined || typeof p.parent_start_time === 'string') &&
    typeof p.created_at === 'string'
  );
}

export function isPidRecord(parsed: unknown): parsed is ProcessPidRecord {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<ProcessPidRecord>;
  return (
    p.schema_version === PROCESS_GENERATION_SCHEMA_VERSION &&
    typeof p.generation_id === 'string' && p.generation_id.length > 0 &&
    isValidPid(p.pid) &&
    (p.start_time === undefined || typeof p.start_time === 'string') &&
    typeof p.created_at === 'string'
  );
}

export function isFailureRecord(parsed: unknown): parsed is ProcessFailureRecord {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<ProcessFailureRecord>;
  return (
    p.schema_version === PROCESS_GENERATION_SCHEMA_VERSION &&
    typeof p.generation_id === 'string' && p.generation_id.length > 0 &&
    typeof p.reason === 'string' &&
    typeof p.created_at === 'string'
  );
}

// === Typed outcomes ===

export type GenerationInspection =
  | { status: 'none' }
  | { status: 'ok'; record: ProcessGenerationRecord }
  | { status: 'malformed'; cause: unknown };

export type CommitSpawning =
  | { kind: 'committed'; record: ProcessGenerationRecord }
  | { kind: 'already_committed'; record: ProcessGenerationRecord }
  | { kind: 'foreign_spawning'; winner: ProcessGenerationRecord }
  | { kind: 'malformed_spawning'; cause: unknown }
  | { kind: 'retryable_failure'; cause: unknown };

export type WriteGenerationFact =
  | { kind: 'written' }
  | { kind: 'generation_moved' }
  | { kind: 'malformed_spawning'; cause: unknown }
  | { kind: 'retryable_failure'; cause: unknown };

export interface GenerationIdentity {
  generationId: string;
  pid: number;
  startTime?: ProcessStartTime;
}

export type ActivateGeneration =
  | { kind: 'activated'; record: ProcessGenerationRecord }
  | { kind: 'already_active'; record: ProcessGenerationRecord }
  | { kind: 'no_spawning' }
  | { kind: 'identity_mismatch'; record: ProcessGenerationRecord }
  | { kind: 'collision'; winner: ProcessGenerationRecord }
  | { kind: 'malformed'; cause: unknown }
  | { kind: 'retryable_failure'; cause: unknown };

export type RetireGeneration =
  | { kind: 'retired'; record: ProcessGenerationRecord }
  | { kind: 'no_generation' }
  | { kind: 'mismatch'; record: ProcessGenerationRecord }
  | { kind: 'collision'; record: ProcessGenerationRecord }
  | { kind: 'malformed'; cause: unknown }
  | { kind: 'retryable_failure'; cause: unknown };

// === Path helpers ===

export function getProcessDir(daemonDir: DaemonDir): string {
  return path.join(daemonDir, STATUS_SUBDIR, PROCESS_DIR_NAME);
}

export function getCandidatesDir(daemonDir: DaemonDir): string {
  return path.join(getProcessDir(daemonDir), CANDIDATES_DIR_NAME);
}

export function getCandidateDir(daemonDir: DaemonDir, generationId: string): string {
  return path.join(getCandidatesDir(daemonDir), generationId);
}

export function getSpawningDir(daemonDir: DaemonDir): string {
  return path.join(getProcessDir(daemonDir), SPAWNING_DIR_NAME);
}

export function getActiveDir(daemonDir: DaemonDir): string {
  return path.join(getProcessDir(daemonDir), ACTIVE_DIR_NAME);
}

export function getRetiredDirFor(daemonDir: DaemonDir, generationId: string): string {
  return path.join(getProcessDir(daemonDir), RETIRED_DIR_NAME, generationId);
}

export function getStopIntentsDir(daemonDir: DaemonDir): string {
  return path.join(getProcessDir(daemonDir), STOP_INTENTS_DIR_NAME);
}

// === Preparation ===

/** 生成一次 spawn generation 的完整 record（写 candidate 前的事实全集，DP1/DP5）。 */
export function newProcessGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
): ProcessGenerationRecord {
  const parentStartTime = (ctx.getProcessStartTime ?? defaultGetProcessStartTime)(process.pid);
  return {
    schema_version: PROCESS_GENERATION_SCHEMA_VERSION,
    generation_id: newUuid(),
    daemon_dir: daemonDir,
    parent_pid: process.pid,
    ...(parentStartTime !== undefined ? { parent_start_time: parentStartTime } : {}),
    created_at: new Date().toISOString(),
  };
}

/**
 * 在私有 candidate 目录完整写入 `generation.json` 并持久化。
 * candidate 即完整 spawn 请求事实：commit 前崩溃也留有证据。
 */
export function prepareGeneration(ctx: ProcessManagerContext, record: ProcessGenerationRecord): void {
  const dir = getCandidateDir(record.daemon_dir as DaemonDir, record.generation_id);
  ctx.fs.ensureDirSync(dir);
  ctx.fs.writeAtomicSync(path.join(dir, GENERATION_FILE), JSON.stringify(record, null, 2));
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_PREPARED,
    `daemon_dir=${record.daemon_dir}`,
    `generation=${record.generation_id}`,
    `parent_pid=${record.parent_pid}`,
  );
}

// === Inspection ===

function readGenerationFile(fs: ProcessManagerContext['fs'], dir: string): GenerationInspection {
  let content: string;
  try {
    content = fs.readSync(path.join(dir, GENERATION_FILE));
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isGenerationRecord(parsed)) return { status: 'malformed', cause: 'generation_shape_mismatch' };
    return { status: 'ok', record: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
}

function readPidFile(fs: ProcessManagerContext['fs'], dir: string):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessPidRecord }
  | { status: 'malformed'; cause: unknown } {
  let content: string;
  try {
    content = fs.readSync(path.join(dir, PID_FILE));
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isPidRecord(parsed)) return { status: 'malformed', cause: 'pid_shape_mismatch' };
    return { status: 'ok', record: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
}

/** 读 spawning generation；不猜错误码 —— 读不到/畸形都显式分型。 */
export function inspectSpawning(ctx: ProcessManagerContext, daemonDir: DaemonDir): GenerationInspection {
  return readGenerationFile(ctx.fs, getSpawningDir(daemonDir));
}

/** 读 active generation；不猜错误码 —— 读不到/畸形都显式分型。 */
export function inspectActive(ctx: ProcessManagerContext, daemonDir: DaemonDir): GenerationInspection {
  return readGenerationFile(ctx.fs, getActiveDir(daemonDir));
}

/** 读 spawning 内 pid 事实（parent 提交 child PID 后存在）。 */
export function inspectSpawningPid(ctx: ProcessManagerContext, daemonDir: DaemonDir):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessPidRecord }
  | { status: 'malformed'; cause: unknown } {
  return readPidFile(ctx.fs, getSpawningDir(daemonDir));
}

/** 读 active 内 pid 事实。 */
export function inspectActivePid(ctx: ProcessManagerContext, daemonDir: DaemonDir):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessPidRecord }
  | { status: 'malformed'; cause: unknown } {
  return readPidFile(ctx.fs, getActiveDir(daemonDir));
}

/** 读 spawning/active 内 ready 事实。 */
function readReadyFile(fs: ProcessManagerContext['fs'], dir: string):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessReadyRecord }
  | { status: 'malformed'; cause: unknown } {
  let content: string;
  try {
    content = fs.readSync(path.join(dir, READY_FILE));
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isPidRecord(parsed)) return { status: 'malformed', cause: 'ready_shape_mismatch' };
    return { status: 'ok', record: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
}

export function inspectSpawningReady(ctx: ProcessManagerContext, daemonDir: DaemonDir):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessReadyRecord }
  | { status: 'malformed'; cause: unknown } {
  return readReadyFile(ctx.fs, getSpawningDir(daemonDir));
}

export function inspectActiveReady(ctx: ProcessManagerContext, daemonDir: DaemonDir):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessReadyRecord }
  | { status: 'malformed'; cause: unknown } {
  return readReadyFile(ctx.fs, getActiveDir(daemonDir));
}

/** 读 retired/<generation-id>/generation.json；用于 stop 验证目标 generation 是否已被处置。 */
export function inspectRetiredGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
): GenerationInspection {
  return readGenerationFile(ctx.fs, getRetiredDirFor(daemonDir, generationId));
}

/** 读指定 generation 目录内 failure 事实（spawning 或 retired）。 */
function readFailureFile(fs: ProcessManagerContext['fs'], dir: string):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessFailureRecord }
  | { status: 'malformed'; cause: unknown } {
  let content: string;
  try {
    content = fs.readSync(path.join(dir, FAILURE_FILE));
  } catch (err) {
    if (isFileNotFound(err)) return { status: 'none' };
    return { status: 'malformed', cause: formatErr(err) };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isFailureRecord(parsed)) return { status: 'malformed', cause: 'failure_shape_mismatch' };
    return { status: 'ok', record: parsed };
  } catch (err) {
    return { status: 'malformed', cause: formatErr(err) };
  }
}

/** 读 spawning 内 failure 事实（parent 在 retire 前写入）。 */
export function inspectSpawningFailure(ctx: ProcessManagerContext, daemonDir: DaemonDir):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessFailureRecord }
  | { status: 'malformed'; cause: unknown } {
  return readFailureFile(ctx.fs, getSpawningDir(daemonDir));
}

/** 读 retired/<generation-id> 内 failure 事实（failure 随 generation 整体 retire）。 */
export function inspectRetiredFailure(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  generationId: string,
):
  | { status: 'none' }
  | { status: 'ok'; record: ProcessFailureRecord }
  | { status: 'malformed'; cause: unknown } {
  return readFailureFile(ctx.fs, getRetiredDirFor(daemonDir, generationId));
}

// === Commit (candidate → spawning) ===

/**
 * 将整个非空 candidate 目录 move 到固定 `status/process/spawning`。
 * destination 不存在时恰好一个 rename 成功；collision 后重读 spawning 形成
 * typed outcome（不从错误码猜 winner）。畸形 spawning fail-closed 并 audit。
 */
export function commitSpawning(ctx: ProcessManagerContext, record: ProcessGenerationRecord): CommitSpawning {
  const daemonDir = record.daemon_dir as DaemonDir;
  const src = getCandidateDir(daemonDir, record.generation_id);
  try {
    ctx.fs.moveDirSync(src, getSpawningDir(daemonDir));
  } catch (moveErr) {
    return resolveCommitCollision(ctx, record, formatErr(moveErr));
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMITTED,
    `daemon_dir=${record.daemon_dir}`,
    `generation=${record.generation_id}`,
    `parent_pid=${record.parent_pid}`,
  );
  return { kind: 'committed', record };
}

function resolveCommitCollision(
  ctx: ProcessManagerContext,
  record: ProcessGenerationRecord,
  moveErr: unknown,
): CommitSpawning {
  const inspection = inspectSpawning(ctx, record.daemon_dir as DaemonDir);
  if (inspection.status === 'ok') {
    const winner = inspection.record;
    if (winner.generation_id === record.generation_id) {
      // 本 generation 前次 commit 已成功但结果丢失（崩溃窗口）→ 幂等收敛
      return { kind: 'already_committed', record: winner };
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST,
      `daemon_dir=${record.daemon_dir}`,
      `generation=${record.generation_id}`,
      `winner_generation=${winner.generation_id}`,
      `winner_parent_pid=${winner.parent_pid}`,
    );
    return { kind: 'foreign_spawning', winner };
  }
  if (inspection.status === 'malformed') {
    // 畸形 spawning：fail-closed，不覆盖、不猜 winner
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${record.daemon_dir}`,
      `generation=${record.generation_id}`,
      `dir=spawning`,
      `reason=${ctx.audit.message(formatErr(inspection.cause))}`,
    );
    return { kind: 'malformed_spawning', cause: inspection.cause };
  }
  // move 失败但 spawning 不存在 = 瞬时 IO 故障（source 仍在 candidate）
  return { kind: 'retryable_failure', cause: moveErr };
}

// === Child PID fact (parent, post-spawn) ===

/**
 * parent 在 spawn 成功后把真实 child PID + startTime 写入 spawning 内
 * `pid.json`。写前重读 spawning 确认本 generation 仍在位；用
 * existing-generation 语义（writeAtomicExisting，不创建 parent）——目录已被
 * move 走时 temp 创建即 ENOENT，绝不复活已移动的 generation。
 */
export async function writeChildPid(
  ctx: ProcessManagerContext,
  record: ProcessGenerationRecord,
  childPid: number,
  childStartTime?: ProcessStartTime,
): Promise<WriteGenerationFact> {
  const daemonDir = record.daemon_dir as DaemonDir;
  const inspection = inspectSpawning(ctx, daemonDir);
  if (inspection.status === 'malformed') return { kind: 'malformed_spawning', cause: inspection.cause };
  if (inspection.status === 'none' || inspection.record.generation_id !== record.generation_id) {
    return { kind: 'generation_moved' };
  }
  const pidRecord: ProcessPidRecord = {
    schema_version: PROCESS_GENERATION_SCHEMA_VERSION,
    generation_id: record.generation_id,
    pid: childPid,
    ...(childStartTime !== undefined ? { start_time: childStartTime } : {}),
    created_at: new Date().toISOString(),
  };
  try {
    await ctx.fs.writeAtomicExisting(
      path.join(getSpawningDir(daemonDir), PID_FILE),
      JSON.stringify(pidRecord, null, 2),
    );
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'generation_moved' };
    return { kind: 'retryable_failure', cause: formatErr(err) };
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_PID_WROTE,
    `daemon_dir=${record.daemon_dir}`,
    `generation=${record.generation_id}`,
    `pid=${childPid}`,
  );
  return { kind: 'written' };
}

// === Ready fact (child, pre-activate) ===

/**
 * child 在 Assembly 成功后把 ready 事实写入 spawning 内 `ready.json`。
 * 写前重读 spawning 确认本 generation 仍在位；完整 ready 事实在 spawning 内
 * 写好后整体 move 到 active（单 SoT，Step C 风险）。
 */
export async function writeReadyFact(
  ctx: ProcessManagerContext,
  record: ProcessGenerationRecord,
  pid: number,
  startTime?: ProcessStartTime,
): Promise<WriteGenerationFact> {
  const daemonDir = record.daemon_dir as DaemonDir;
  const inspection = inspectSpawning(ctx, daemonDir);
  if (inspection.status === 'malformed') return { kind: 'malformed_spawning', cause: inspection.cause };
  if (inspection.status === 'none' || inspection.record.generation_id !== record.generation_id) {
    return { kind: 'generation_moved' };
  }
  const readyRecord: ProcessReadyRecord = {
    schema_version: PROCESS_GENERATION_SCHEMA_VERSION,
    generation_id: record.generation_id,
    pid,
    ...(startTime !== undefined ? { start_time: startTime } : {}),
    created_at: new Date().toISOString(),
  };
  try {
    await ctx.fs.writeAtomicExisting(
      path.join(getSpawningDir(daemonDir), READY_FILE),
      JSON.stringify(readyRecord, null, 2),
    );
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'generation_moved' };
    return { kind: 'retryable_failure', cause: formatErr(err) };
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_READY_WROTE,
    `daemon_dir=${record.daemon_dir}`,
    `generation=${record.generation_id}`,
    `pid=${pid}`,
  );
  return { kind: 'written' };
}

// === Failure fact ===

/**
 * 在 spawning 内写 immutable failure 事实（retire 前调用）。
 * existing-generation 语义：目录已 move 走则返回 generation_moved、不复活。
 */
export async function writeFailureFact(
  ctx: ProcessManagerContext,
  record: ProcessGenerationRecord,
  reason: string,
): Promise<WriteGenerationFact> {
  const daemonDir = record.daemon_dir as DaemonDir;
  const inspection = inspectSpawning(ctx, daemonDir);
  if (inspection.status === 'malformed') return { kind: 'malformed_spawning', cause: inspection.cause };
  if (inspection.status === 'none' || inspection.record.generation_id !== record.generation_id) {
    return { kind: 'generation_moved' };
  }
  const failure: ProcessFailureRecord = {
    schema_version: PROCESS_GENERATION_SCHEMA_VERSION,
    generation_id: record.generation_id,
    reason,
    created_at: new Date().toISOString(),
  };
  try {
    await ctx.fs.writeAtomicExisting(
      path.join(getSpawningDir(daemonDir), FAILURE_FILE),
      JSON.stringify(failure, null, 2),
    );
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'generation_moved' };
    return { kind: 'retryable_failure', cause: formatErr(err) };
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_FAILED,
    `daemon_dir=${record.daemon_dir}`,
    `generation=${record.generation_id}`,
    `reason=${ctx.audit.message(reason)}`,
  );
  return { kind: 'written' };
}

// === Activate (spawning → active) ===

/**
 * child 在 Assembly 成功 + ready 事实写好后将本 generation 从 spawning move
 * 到 active。只认显式 generation identity（generation ID + PID + startTime
 * 全匹配）；active collision 重读 winner 形成 typed outcome，loser 退出、
 * 绝不覆盖 fresh active。
 */
export function activateGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  expected: GenerationIdentity,
): ActivateGeneration {
  const inspection = inspectSpawning(ctx, daemonDir);
  if (inspection.status === 'none') return { kind: 'no_spawning' };
  if (inspection.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `generation=${expected.generationId}`,
      `dir=spawning`,
      `ctx=activate`,
      `reason=${ctx.audit.message(formatErr(inspection.cause))}`,
    );
    return { kind: 'malformed', cause: inspection.cause };
  }
  const record = inspection.record;
  if (record.generation_id !== expected.generationId) {
    return { kind: 'identity_mismatch', record };
  }
  // PID/startTime 交叉校验：pid.json 必须是 parent 为本 generation 写的同一 child
  const pidInspection = inspectSpawningPid(ctx, daemonDir);
  if (pidInspection.status === 'malformed') return { kind: 'malformed', cause: pidInspection.cause };
  if (pidInspection.status === 'none' || pidInspection.record.pid !== expected.pid) {
    return { kind: 'identity_mismatch', record };
  }
  if (
    expected.startTime !== undefined &&
    pidInspection.record.start_time !== undefined &&
    pidInspection.record.start_time !== expected.startTime
  ) {
    return { kind: 'identity_mismatch', record };
  }
  try {
    ctx.fs.moveDirSync(getSpawningDir(daemonDir), getActiveDir(daemonDir));
  } catch (moveErr) {
    return resolveActivateCollision(ctx, daemonDir, record, formatErr(moveErr));
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_ACTIVATED,
    `daemon_dir=${daemonDir}`,
    `generation=${record.generation_id}`,
    `pid=${expected.pid}`,
  );
  return { kind: 'activated', record };
}

function resolveActivateCollision(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  record: ProcessGenerationRecord,
  moveErr: unknown,
): ActivateGeneration {
  const inspection = inspectActive(ctx, daemonDir);
  if (inspection.status === 'ok') {
    const winner = inspection.record;
    if (winner.generation_id === record.generation_id) {
      // 本 generation 前次 activate 已成功但结果丢失（崩溃窗口）→ 幂等收敛
      return { kind: 'already_active', record: winner };
    }
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_COMMIT_LOST,
      `daemon_dir=${daemonDir}`,
      `generation=${record.generation_id}`,
      `ctx=activate`,
      `winner_generation=${winner.generation_id}`,
    );
    return { kind: 'collision', winner };
  }
  if (inspection.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `generation=${record.generation_id}`,
      `dir=active`,
      `ctx=activate`,
      `reason=${ctx.audit.message(formatErr(inspection.cause))}`,
    );
    return { kind: 'malformed', cause: inspection.cause };
  }
  return { kind: 'retryable_failure', cause: moveErr };
}

// === Retire (spawning|active → retired/<generation-id>) ===

/**
 * shutdown / confirmed-dead / failed 将 generation 目录 move 到由 generation
 * ID 稳定派生的 `retired/<generation-id>`。retire 前 fresh-read 源目录并要求
 * generation ID 匹配（迟到 retire 不动 fresh generation）；destination 已
 * 存在（非空）时 rename 必失败 → 另一 reclaimer 已处置该 generation。
 */
export function retireGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  expected: { generationId: string },
  reason: 'shutdown' | 'confirmed_dead' | 'spawn_failed' | 'assembly_failed' | 'stopped',
  source: 'spawning' | 'active',
): RetireGeneration {
  const srcDir = source === 'spawning' ? getSpawningDir(daemonDir) : getActiveDir(daemonDir);
  const inspection = readGenerationFile(ctx.fs, srcDir);
  if (inspection.status === 'none') return { kind: 'no_generation' };
  if (inspection.status === 'malformed') {
    ctx.audit.write(
      PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_MALFORMED,
      `daemon_dir=${daemonDir}`,
      `generation=${expected.generationId}`,
      `dir=${source}`,
      `ctx=retire`,
      `reason=${ctx.audit.message(formatErr(inspection.cause))}`,
    );
    return { kind: 'malformed', cause: inspection.cause };
  }
  const record = inspection.record;
  if (record.generation_id !== expected.generationId) {
    // 旧 generation 迟到 shutdown/reclaim：不动 fresh generation
    return { kind: 'mismatch', record };
  }
  const retiredDest = getRetiredDirFor(daemonDir, record.generation_id);
  if (ctx.fs.existsSync(retiredDest)) {
    // 另一 reclaimer 已处置该 generation；destination 永久非空、不可覆盖
    return { kind: 'collision', record };
  }
  try {
    ctx.fs.moveDirSync(srcDir, retiredDest);
  } catch (moveErr) {
    if (ctx.fs.existsSync(retiredDest)) return { kind: 'collision', record };
    return { kind: 'retryable_failure', cause: formatErr(moveErr) };
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.GENERATION_RETIRED,
    `daemon_dir=${daemonDir}`,
    `generation=${record.generation_id}`,
    `from=${source}`,
    `reason=${reason}`,
  );
  return { kind: 'retired', record };
}


// === Stop intents ===

export interface StopIntentRecord {
  schema_version: number;
  request_id: string;
  target_generation_id: string;
  observed_location: 'spawning' | 'active' | null;
  daemon_dir: string;
  created_at: string;
}

export type WriteStopIntentResult =
  | { kind: 'written'; intent: StopIntentRecord }
  | { kind: 'retryable_failure'; cause: unknown };

export type StopIntentScanResult =
  | { kind: 'ok'; requestIds: string[] }
  | { kind: 'malformed'; requestId: string; cause: unknown }
  | { kind: 'unreadable'; cause: unknown };

function stopIntentFileName(requestId: string): string {
  return `${requestId}.json`;
}

function getStopIntentPath(daemonDir: DaemonDir, requestId: string): string {
  return path.join(getStopIntentsDir(daemonDir), stopIntentFileName(requestId));
}

function isStopIntentRecord(parsed: unknown): parsed is StopIntentRecord {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Partial<StopIntentRecord>;
  return (
    p.schema_version === PROCESS_GENERATION_SCHEMA_VERSION &&
    typeof p.request_id === 'string' && p.request_id.length > 0 &&
    typeof p.target_generation_id === 'string' && p.target_generation_id.length > 0 &&
    (p.observed_location === 'spawning' || p.observed_location === 'active' || p.observed_location === null) &&
    typeof p.daemon_dir === 'string' && p.daemon_dir.length > 0 &&
    typeof p.created_at === 'string'
  );
}

/**
 * 持久化不可变的 stop intent。每个 stop request 写一个独立文件，request_id 由 caller
 * 生成（通常为 UUID）。intent 显式绑定调用时观察到的目标 generation，不得约束未来
 * generation。失败时返回 retryable，不猜 winner。
 */
export function writeStopIntent(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  requestId: string,
  targetGenerationId: string,
  observedLocation: 'spawning' | 'active' | null = null,
): WriteStopIntentResult {
  const intent: StopIntentRecord = {
    schema_version: PROCESS_GENERATION_SCHEMA_VERSION,
    request_id: requestId,
    target_generation_id: targetGenerationId,
    observed_location: observedLocation,
    daemon_dir: daemonDir,
    created_at: new Date().toISOString(),
  };
  try {
    ctx.fs.ensureDirSync(getStopIntentsDir(daemonDir));
    ctx.fs.writeAtomicSync(getStopIntentPath(daemonDir, requestId), JSON.stringify(intent, null, 2));
  } catch (err) {
    return { kind: 'retryable_failure', cause: formatErr(err) };
  }
  ctx.audit.write(
    PROCESS_MANAGER_AUDIT_EVENTS.STOP_INTENT_RECORDED,
    `daemon_dir=${daemonDir}`,
    `request_id=${requestId}`,
    `target_generation=${targetGenerationId}`,
    `observed_location=${observedLocation ?? 'none'}`,
  );
  return { kind: 'written', intent };
}

/**
 * 扫描所有 stop intent，返回绑定到指定 target generation 的 request_id 列表。
 * 畸形文件或目录不可读时返回 typed outcome，不吞异常、不当作空集合。
 */
export function scanStopIntentsForGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  targetGenerationId: string,
): StopIntentScanResult {
  const dir = getStopIntentsDir(daemonDir);
  let entries: { name: string }[];
  try {
    entries = ctx.fs.listSync(dir, { includeDirs: false });
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'ok', requestIds: [] };
    return { kind: 'unreadable', cause: formatErr(err) };
  }

  const requestIds: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const requestId = entry.name.slice(0, -'.json'.length);
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = ctx.fs.readSync(filePath);
    } catch (err) {
      return { kind: 'unreadable', cause: formatErr(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return { kind: 'malformed', requestId, cause: formatErr(err) };
    }
    if (!isStopIntentRecord(parsed)) {
      return { kind: 'malformed', requestId, cause: 'stop_intent_shape_mismatch' };
    }
    if (parsed.target_generation_id === targetGenerationId) {
      requestIds.push(requestId);
    }
  }
  return { kind: 'ok', requestIds };
}

/**
 * 是否存在针对指定 generation 的 stop intent。扫描失败时按 fail-closed 返回 true
 *（调用方应中止 spawn），同时写 audit。
 */
export function hasStopIntentForGeneration(
  ctx: ProcessManagerContext,
  daemonDir: DaemonDir,
  targetGenerationId: string,
): boolean {
  const scan = scanStopIntentsForGeneration(ctx, daemonDir, targetGenerationId);
  if (scan.kind === 'ok') {
    return scan.requestIds.length > 0;
  }
  ctx.audit.write(
    scan.kind === 'malformed'
      ? PROCESS_MANAGER_AUDIT_EVENTS.STOP_INTENT_MALFORMED
      : PROCESS_MANAGER_AUDIT_EVENTS.STOP_INTENT_SCAN_FAILED,
    `daemon_dir=${daemonDir}`,
    `target_generation=${targetGenerationId}`,
    `reason=${ctx.audit.message(formatErr(scan.cause))}`,
  );
  return true;
}
