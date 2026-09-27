import type { AuditLog } from '../audit/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from './audit-events.js';

// === INIT_FAILED ===
type SnapshotInitFailedPayload = {
  dir: string;
  kind?: string;
  context?: 'incomplete_repo_reinit';
};

export function emitSnapshotInitFailed(audit: AuditLog, opts: SnapshotInitFailedPayload): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.kind !== undefined) cols.push(`kind=${opts.kind}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.INIT_FAILED, ...cols);
}

// === INIT_CLEANUP_FAILED ===
export function emitSnapshotInitCleanupFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.INIT_CLEANUP_FAILED, `dir=${opts.dir}`, `reason=${opts.reason}`);
}

// === COMMIT_FAILED ===
type SnapshotCommitFailedPayload = {
  dir: string;
  kind?: string;
  consecutive?: number;
  context?: 'state_restored_from_disk' | 'persist_failed';
};

export function emitSnapshotCommitFailed(audit: AuditLog, opts: SnapshotCommitFailedPayload): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.kind !== undefined) cols.push(`kind=${opts.kind}`);
  if (opts.consecutive !== undefined) cols.push(`consecutive=${opts.consecutive}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED, ...cols);
}

// === COMMITTED ===
export function emitSnapshotCommitted(audit: AuditLog, opts: {
  dir: string;
  message: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.COMMITTED, `dir=${opts.dir}`, `message=${opts.message}`);
}

// === DEGRADED ===
export function emitSnapshotDegraded(audit: AuditLog, opts: {
  dir: string;
  consecutive: number;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.DEGRADED, `dir=${opts.dir}`, `consecutive=${opts.consecutive}`);
}

// === SYNC_CLEAN_FAILED ===
type SnapshotSyncCleanFailedPayload = {
  dir: string;
  context?: 'empty_or_escaping_relDir' | 'realpath_failed' | 'symlink_traversal';
  cleanupDir?: string;
  resolved?: string;
  reason?: string;
};

export function emitSnapshotSyncCleanFailed(audit: AuditLog, opts: SnapshotSyncCleanFailedPayload): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.cleanupDir !== undefined) cols.push(`cleanupDir=${opts.cleanupDir}`);
  if (opts.resolved !== undefined) cols.push(`resolved=${opts.resolved}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED, ...cols);
}

// === SYNC_RESTORE_FAILED ===
export function emitSnapshotSyncRestoreFailed(audit: AuditLog, opts: {
  dir: string;
  restoreReason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.SYNC_RESTORE_FAILED, `dir=${opts.dir}`, `restoreReason=${opts.restoreReason}`);
}

// === STATUS_STDERR ===
export function emitSnapshotStatusStderr(audit: AuditLog, opts: {
  dir: string;
  stderr: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.STATUS_STDERR, `dir=${opts.dir}`, `stderr=${opts.stderr}`);
}

// === PERSIST_FAILED ===
export function emitSnapshotPersistFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.PERSIST_FAILED, `dir=${opts.dir}`, `reason=${opts.reason}`);
}

// === TRY_CLEAR_FAILED ===
export function emitSnapshotTryClearFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.TRY_CLEAR_FAILED, `dir=${opts.dir}`, `reason=${opts.reason}`);
}

// === STATE_CORRUPT ===
// phase 699: 加 dir col、与同模块其他 emit (INIT_FAILED 等) 'dir=' 起头形态对齐
export function emitSnapshotStateCorrupt(audit: AuditLog, opts: {
  dir: string;
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.STATE_CORRUPT, `dir=${opts.dir}`, `reason=${opts.reason}`);
}

// === REALPATH_FAILED ===
export function emitSnapshotRealpathFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.REALPATH_FAILED, `dir=${opts.dir}`, `reason=${opts.reason}`);
}

// === LEGACY_SCHEMA_MIGRATED ===
export function emitSnapshotLegacySchemaMigrated(audit: AuditLog, opts: {
  failures: number;
  degradedAt?: number;
}): void {
  const cols: (string | number)[] = [`failures=${opts.failures}`];
  if (opts.degradedAt !== undefined) cols.push(`degradedAt=${opts.degradedAt}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED, ...cols);
}

// === VERSION_INIT_FAILED (phase 1918 Step B) ===
export function emitSnapshotVersionInitFailed(audit: AuditLog, opts: {
  dir: string;
  kind: string;
  reason?: string;
}): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`, `kind=${opts.kind}`];
  if (opts.reason !== undefined) cols.push(`reason=${audit.message(opts.reason)}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.VERSION_INIT_FAILED, ...cols);
}

// === VERSION_WORKSPACE_BEGAN (phase 1918 Step B) ===
export function emitSnapshotVersionWorkspaceBegan(audit: AuditLog, opts: {
  dir: string;
  workspace: string;
  base: string;
  branch: string;
  operationId: string;
}): void {
  audit.write(
    SNAPSHOT_AUDIT_EVENTS.VERSION_WORKSPACE_BEGAN,
    `dir=${opts.dir}`,
    `workspace=${opts.workspace}`,
    `base=${opts.base}`,
    `branch=${opts.branch}`,
    `operationId=${audit.message(opts.operationId)}`,
  );
}

// === VERSION_SAVED (phase 1918 Step B) ===
export function emitSnapshotVersionSaved(audit: AuditLog, opts: {
  dir: string;
  workspace: string;
  version: string;
  operationId: string;
  outcome?: 'no_change';
}): void {
  const cols: (string | number)[] = [
    `dir=${opts.dir}`,
    `workspace=${opts.workspace}`,
    `version=${opts.version}`,
    `operationId=${audit.message(opts.operationId)}`,
  ];
  if (opts.outcome !== undefined) cols.push(`outcome=${opts.outcome}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.VERSION_SAVED, ...cols);
}

// === VERSION_SAVE_FAILED (phase 1918 Step B) ===
export function emitSnapshotVersionSaveFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
  workspace?: string;
  operationId?: string;
}): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`, `reason=${audit.message(opts.reason)}`];
  if (opts.workspace !== undefined) cols.push(`workspace=${opts.workspace}`);
  if (opts.operationId !== undefined) cols.push(`operationId=${audit.message(opts.operationId)}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.VERSION_SAVE_FAILED, ...cols);
}

// === VERSION_PUBLISHED (phase 1918 Step C) ===
export function emitSnapshotVersionPublished(audit: AuditLog, opts: {
  dir: string;
  prefix: string;
  version: string;
  operationId: string;
  /** recovered = CAS 已成功但回执丢失，按 ref 历史识别已提交（未再次发布） */
  outcome?: 'recovered';
}): void {
  const cols: (string | number)[] = [
    `dir=${opts.dir}`,
    `prefix=${opts.prefix}`,
    `version=${opts.version}`,
    `operationId=${audit.message(opts.operationId)}`,
  ];
  if (opts.outcome !== undefined) cols.push(`outcome=${opts.outcome}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISHED, ...cols);
}

// === VERSION_PUBLISH_CONFLICT (phase 1918 Step C) ===
export function emitSnapshotVersionPublishConflict(audit: AuditLog, opts: {
  dir: string;
  prefix: string;
  current: string;
  candidate: string;
  operationId: string;
}): void {
  audit.write(
    SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_CONFLICT,
    `dir=${opts.dir}`,
    `prefix=${opts.prefix}`,
    `current=${opts.current}`,
    `candidate=${opts.candidate}`,
    `operationId=${audit.message(opts.operationId)}`,
  );
}

// === VERSION_PUBLISH_BUSY (phase 1918 Step C) ===
export function emitSnapshotVersionPublishBusy(audit: AuditLog, opts: {
  dir: string;
  prefix: string;
  operationId: string;
  attempts: number;
}): void {
  audit.write(
    SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_BUSY,
    `dir=${opts.dir}`,
    `prefix=${opts.prefix}`,
    `operationId=${audit.message(opts.operationId)}`,
    `attempts=${opts.attempts}`,
  );
}

// === VERSION_PUBLISH_FAILED (phase 1918 Step C) ===
export function emitSnapshotVersionPublishFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
  prefix?: string;
  operationId?: string;
}): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`, `reason=${audit.message(opts.reason)}`];
  if (opts.prefix !== undefined) cols.push(`prefix=${opts.prefix}`);
  if (opts.operationId !== undefined) cols.push(`operationId=${audit.message(opts.operationId)}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.VERSION_PUBLISH_FAILED, ...cols);
}

// === VERSION_EXPORTED (phase 1918 Step D) ===
export function emitSnapshotVersionExported(audit: AuditLog, opts: {
  dir: string;
  version: string;
  prefix: string;
  destination: string;
}): void {
  audit.write(
    SNAPSHOT_AUDIT_EVENTS.VERSION_EXPORTED,
    `dir=${opts.dir}`,
    `version=${opts.version}`,
    `prefix=${opts.prefix}`,
    `destination=${opts.destination}`,
  );
}

// === VERSION_EXPORT_FAILED (phase 1918 Step D) ===
export function emitSnapshotVersionExportFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
  version?: string;
  prefix?: string;
  destination?: string;
}): void {
  const cols: (string | number)[] = [`dir=${opts.dir}`, `reason=${audit.message(opts.reason)}`];
  if (opts.version !== undefined) cols.push(`version=${opts.version}`);
  if (opts.prefix !== undefined) cols.push(`prefix=${opts.prefix}`);
  if (opts.destination !== undefined) cols.push(`destination=${opts.destination}`);
  audit.write(SNAPSHOT_AUDIT_EVENTS.VERSION_EXPORT_FAILED, ...cols);
}
