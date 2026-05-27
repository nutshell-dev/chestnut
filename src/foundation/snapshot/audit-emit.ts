import type { AuditLog } from '../audit/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from './audit-events.js';

// === INIT_FAILED ===
export type SnapshotInitFailedPayload = {
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
export type SnapshotCommitFailedPayload = {
  dir: string;
  kind?: string;
  consecutive?: number;
  context?: 'state_restored_from_disk';
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
export type SnapshotSyncCleanFailedPayload = {
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
export function emitSnapshotStateCorrupt(audit: AuditLog, opts: {
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.STATE_CORRUPT, `reason=${opts.reason}`);
}

// === REALPATH_FAILED ===
export function emitSnapshotRealpathFailed(audit: AuditLog, opts: {
  dir: string;
  reason: string;
}): void {
  audit.write(SNAPSHOT_AUDIT_EVENTS.REALPATH_FAILED, `dir=${opts.dir}`, `reason=${opts.reason}`);
}
