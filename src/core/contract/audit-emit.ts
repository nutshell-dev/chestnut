/**
 * @module L4.ContractSystem.AuditEmit
 * Typed audit emit functions for contract module.
 *
 * Per-event typed payload enforces phase 706 audit key naming decision tree
 * (business ID typed camelCase: contractId= / subtaskId=).
 * Zero audit row format change — typed emit serializes bit-identical to string col
 * except 7 key-fix sites where ${contractId}/${subtaskId} split into 2 cols.
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/utils/format.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

// ─── LOCK_CLEARED ───────────────────────────────────────────────────────────
export function emitContractLockCleared(
  audit: AuditLog,
  opts: { pid: number; timeout: number; reason: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.LOCK_CLEARED,
    `pid=${opts.pid}`,
    `timeout=${opts.timeout}`,
    `reason=${opts.reason}`,
  );
}

// ─── LOCK_UNLINK_FAILED ─────────────────────────────────────────────────────
export function emitContractLockUnlinkFailed(
  audit: AuditLog,
  opts: {
    context?: string;
    path?: string;
    reason?: string;
    expectedPid?: number;
    actualPid?: number;
    error?: string;
  },
): void {
  const cols: string[] = [];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.path !== undefined) cols.push(`path=${opts.path}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.expectedPid !== undefined) cols.push(`expected_pid=${opts.expectedPid}`);
  if (opts.actualPid !== undefined) cols.push(`actual_pid=${opts.actualPid}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.LOCK_UNLINK_FAILED, ...cols);
}

// ─── LOCK_SCHEMA_INVALID ────────────────────────────────────────────────────
export function emitContractLockSchemaInvalid(
  audit: AuditLog,
  opts: { path: string; raw: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.LOCK_SCHEMA_INVALID,
    `path=${opts.path}`,
    `raw=${opts.raw}`,
  );
}

// ─── LOCK_CLEANUP_FAILED ────────────────────────────────────────────────────
export function emitContractLockCleanupFailed(
  audit: AuditLog,
  opts: { reason: string; code?: string; error?: string },
): void {
  const cols: string[] = [opts.reason];
  if (opts.code !== undefined) cols.push(opts.code);
  if (opts.error !== undefined) cols.push(opts.error);
  audit.write(CONTRACT_AUDIT_EVENTS.LOCK_CLEANUP_FAILED, ...cols);
}

// ─── PROGRESS_SCHEMA_INVALID ────────────────────────────────────────────────
export function emitContractProgressSchemaInvalid(
  audit: AuditLog,
  opts: {
    contractId?: string;
    path?: string;
    context?: string;
    contract?: string;
    reason?: string;
    actual?: string;
    current?: number;
    raw?: string;
  },
): void {
  const cols: string[] = [];
  if (opts.contractId !== undefined) cols.push(`contractId=${opts.contractId}`);
  if (opts.path !== undefined) cols.push(`path=${opts.path}`);
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.contract !== undefined) cols.push(`contract=${opts.contract}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.actual !== undefined) cols.push(`actual=${opts.actual}`);
  if (opts.current !== undefined) cols.push(`current=${opts.current}`);
  if (opts.raw !== undefined) cols.push(`raw=${opts.raw}`);
  audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID, ...cols);
}

// ─── CONTRACT_YAML_SCHEMA_INVALID ───────────────────────────────────────────
export function emitContractYamlSchemaInvalid(
  audit: AuditLog,
  opts: {
    contractId: string;
    path: string;
    reason?: string;
    actual?: string;
    current?: number;
    raw?: string;
  },
): void {
  const cols: string[] = [`contractId=${opts.contractId}`, `path=${opts.path}`];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.actual !== undefined) cols.push(`actual=${opts.actual}`);
  if (opts.current !== undefined) cols.push(`current=${opts.current}`);
  if (opts.raw !== undefined) cols.push(`raw=${opts.raw}`);
  audit.write(CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID, ...cols);
}

// ─── OBSERVER_STATE_PARSE_FAILED ────────────────────────────────────────────
export function emitContractObserverStateParseFailed(
  audit: AuditLog,
  opts: { path: string; raw: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
    `path=${opts.path}`,
    `raw=${opts.raw}`,
  );
}

// ─── PROGRESS_CORRUPTED ─────────────────────────────────────────────────────
export function emitContractProgressCorrupted(
  audit: AuditLog,
  opts: {
    context?: string;
    contractId?: string;
    subtaskId?: string;
    file?: string;
    contract?: string;
    error?: string;
    message?: string;
  },
): void {
  const cols: string[] = [];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.contractId !== undefined) cols.push(`contractId=${opts.contractId}`);
  if (opts.subtaskId !== undefined) cols.push(`subtaskId=${opts.subtaskId}`);
  if (opts.file !== undefined) cols.push(`file=${opts.file}`);
  if (opts.contract !== undefined) cols.push(`contract=${opts.contract}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  if (opts.message !== undefined) cols.push(`message=${opts.message}`);
  audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED, ...cols);
}

// ─── ARCHIVE_STARTED ────────────────────────────────────────────────────────
export function emitContractArchiveStarted(
  audit: AuditLog,
  opts: { old: string; new: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ARCHIVE_STARTED,
    `old=${opts.old}`,
    `new=${opts.new}`,
  );
}

// ─── ROLLBACK_FAILED ────────────────────────────────────────────────────────
export function emitContractRollbackFailed(
  audit: AuditLog,
  opts: { contractId: string; error: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ROLLBACK_FAILED,
    `contractId=${opts.contractId}`,
    `error=${opts.error}`,
  );
}

// ─── ROLLBACK_INCOMPLETE ────────────────────────────────────────────────────
export function emitContractRollbackIncomplete(
  audit: AuditLog,
  opts: { contractId: string; remaining: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ROLLBACK_INCOMPLETE,
    `contractId=${opts.contractId}`,
    `remaining=${opts.remaining}`,
  );
}

// ─── CREATED ────────────────────────────────────────────────────────────────
export function emitContractCreated(
  audit: AuditLog,
  opts: { contractId: string; subtasks: number; title: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.CREATED,
    opts.contractId,
    `subtasks=${opts.subtasks}`,
    `title=${opts.title}`,
  );
}

// ─── ACCEPTANCE_STARTED ─────────────────────────────────────────────────────
export function emitContractAcceptanceStarted(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ACCEPTANCE_STARTED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── UPDATED ────────────────────────────────────────────────────────────────
export function emitContractUpdated(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; status: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.UPDATED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `status=${opts.status}`,
  );
}

// ─── NOTIFY_FAILED ──────────────────────────────────────────────────────────
export function emitContractNotifyFailed(
  audit: AuditLog,
  opts: { notifyType?: string; error: string },
): void {
  const cols: string[] = [];
  if (opts.notifyType !== undefined) cols.push(`notify_type=${opts.notifyType}`);
  cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED, ...cols);
}

// ─── MOVE_ARCHIVE_FAILED ────────────────────────────────────────────────────
export function emitContractMoveArchiveFailed(
  audit: AuditLog,
  opts: {
    old?: string;
    new?: string;
    context?: string;
    message?: string;
    reason?: string;
    error?: string;
  },
): void {
  const cols: string[] = [];
  if (opts.old !== undefined) cols.push(`old=${opts.old}`);
  if (opts.new !== undefined) cols.push(`new=${opts.new}`);
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.message !== undefined) cols.push(`message=${opts.message}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED, ...cols);
}

// ─── ACCEPTANCE_INBOX_FAILED ────────────────────────────────────────────────
export function emitContractAcceptanceInboxFailed(
  audit: AuditLog,
  opts: { context?: string; error: string },
): void {
  const cols: string[] = [];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_INBOX_FAILED, ...cols);
}

// ─── ACCEPTANCE_RESET_FAILED ────────────────────────────────────────────────
export function emitContractAcceptanceResetFailed(
  audit: AuditLog,
  opts: {
    contractId?: string;
    subtaskId?: string;
    context?: string;
    message?: string;
    error?: string;
  },
): void {
  const cols: string[] = [];
  if (opts.contractId !== undefined) cols.push(opts.contractId);
  if (opts.subtaskId !== undefined) cols.push(`subtaskId=${opts.subtaskId}`);
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.message !== undefined) cols.push(`message=${opts.message}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED, ...cols);
}

// ─── ACCEPTANCE_BACKGROUND_FAILED ───────────────────────────────────────────
export function emitContractAcceptanceBackgroundFailed(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; error: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ACCEPTANCE_BACKGROUND_FAILED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `error=${opts.error}`,
  );
}

// ─── COMPLETE_ON_CANCELLED ──────────────────────────────────────────────────
export function emitContractCompleteOnCancelled(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; context?: string },
): void {
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  ];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  audit.write(CONTRACT_AUDIT_EVENTS.COMPLETE_ON_CANCELLED, ...cols);
}

// ─── ACCEPTANCE_BACKGROUND_DONE ─────────────────────────────────────────────
export function emitContractAcceptanceBackgroundDone(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; result: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ACCEPTANCE_BACKGROUND_DONE,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `result=${opts.result}`,
  );
}

// ─── ACCEPTANCE_SCRIPT_STARTED ──────────────────────────────────────────────
export function emitContractAcceptanceScriptStarted(
  audit: AuditLog,
  opts: { script: string; cwd: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ACCEPTANCE_SCRIPT_STARTED,
    `script=${opts.script}`,
    `cwd=${opts.cwd}`,
  );
}

// ─── SUBTASK_DUPLICATE_DONE ─────────────────────────────────────────────────
export function emitContractSubtaskDuplicateDone(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_DUPLICATE_DONE,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── SUBTASK_ALREADY_COMPLETED ──────────────────────────────────────────────
export function emitContractSubtaskAlreadyCompleted(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_ALREADY_COMPLETED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── UNEXPECTED_ASYNC_THROW ─────────────────────────────────────────────────
export function emitContractUnexpectedAsyncThrow(
  audit: AuditLog,
  opts: {
    context: string;
    contractId: string;
    subtaskId?: string;
    errorType?: string;
    error: string;
    stack?: string;
  },
): void {
  const cols: string[] = [`context=${opts.context}`, `contractId=${opts.contractId}`];
  if (opts.subtaskId !== undefined) cols.push(`subtaskId=${opts.subtaskId}`);
  if (opts.errorType !== undefined) cols.push(`errorType=${opts.errorType}`);
  cols.push(`error=${opts.error}`);
  if (opts.stack !== undefined) cols.push(`stack=${opts.stack}`);
  audit.write(CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW, ...cols);
}

// ─── PASSED (key-fix site: split ${contractId}/${subtaskId}) ────────────────
export function emitContractPassed(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.PASSED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── CANCELLED ──────────────────────────────────────────────────────────────
export function emitContractCancelled(
  audit: AuditLog,
  opts: { contractId: string; reason?: string; abortVerifierFailed?: string },
): void {
  const cols: string[] = [opts.contractId];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.abortVerifierFailed !== undefined) cols.push(`abort_verifier_failed=${opts.abortVerifierFailed}`);
  audit.write(CONTRACT_AUDIT_EVENTS.CANCELLED, ...cols);
}

// ─── COMPLETED ──────────────────────────────────────────────────────────────
export function emitContractCompleted(
  audit: AuditLog,
  opts: { contractId: string; title: string; claw: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.COMPLETED,
    opts.contractId,
    `title=${opts.title}`,
    `claw=${opts.claw}`,
  );
}

// ─── PAUSED ─────────────────────────────────────────────────────────────────
export function emitContractPaused(
  audit: AuditLog,
  opts: { contractId: string; checkpoint: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.PAUSED,
    opts.contractId,
    `checkpoint=${opts.checkpoint}`,
  );
}

// ─── RESUMED ────────────────────────────────────────────────────────────────
export function emitContractResumed(
  audit: AuditLog,
  opts: { contractId: string },
): void {
  audit.write(CONTRACT_AUDIT_EVENTS.RESUMED, opts.contractId);
}

// ─── SUBTASK_COMPLETED (key-fix site: split ${contractId}/${subtaskId}) ─────
export function emitContractSubtaskCompleted(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; progress: string; claw: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `progress=${opts.progress}`,
    `claw=${opts.claw}`,
  );
}

// ─── ACCEPTANCE_FAILED (key-fix site: split ${contractId}/${subtaskId}) ─────
export function emitContractAcceptanceFailed(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; feedback?: string },
): void {
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  ];
  if (opts.feedback !== undefined) cols.push(`feedback=${opts.feedback}`);
  audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_FAILED, ...cols);
}

// ─── ESCALATED (key-fix site: split ${contractId}/${subtaskId}) ─────────────
export function emitContractEscalated(
  audit: AuditLog,
  opts: {
    contractId: string;
    subtaskId: string;
    retryCount: number;
    claw: string;
    context?: string;
  },
): void {
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `retry_count=${opts.retryCount}`,
    `claw=${opts.claw}`,
  ];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  audit.write(CONTRACT_AUDIT_EVENTS.ESCALATED, ...cols);
}

// ─── ACCEPTANCE_TIMEOUT (key-fix site: split ${contractId}/${subtaskId}) ────
export function emitContractAcceptanceTimeout(
  audit: AuditLog,
  opts: { contractId: string; subtaskId: string; claw: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.ACCEPTANCE_TIMEOUT,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `claw=${opts.claw}`,
  );
}

// ─── VERIFIER_FAILED ──────────────────────────────────────────────────────────
export function emitContractVerifierFailed(
  audit: AuditLog,
  opts: { agentId?: string; clawId?: string; kind?: string; reason?: string },
): void {
  const cols: string[] = [];
  if (opts.agentId !== undefined) cols.push(`agentId=${opts.agentId}`);
  if (opts.clawId !== undefined) cols.push(`clawId=${opts.clawId}`);
  if (opts.kind !== undefined) cols.push(`kind=${opts.kind}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED, ...cols);
}

// ─── VERIFIER_SKIPPED ─────────────────────────────────────────────────────────
export function emitContractVerifierSkipped(
  audit: AuditLog,
  opts: { agentId: string; reason: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED,
    `agentId=${opts.agentId}`,
    `reason=${opts.reason}`,
  );
}

// ─── VERIFIER_STARTED ─────────────────────────────────────────────────────────
export function emitContractVerifierStarted(
  audit: AuditLog,
  opts: { agentId: string; clawId: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_STARTED,
    `agentId=${opts.agentId}`,
    `clawId=${opts.clawId}`,
  );
}

// ─── VERIFIER_PASSED ──────────────────────────────────────────────────────────
export function emitContractVerifierPassed(
  audit: AuditLog,
  opts: { agentId: string },
): void {
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED, `agentId=${opts.agentId}`);
}

// ─── VERIFIER_RESULT_PARSE_FAILED ─────────────────────────────────────────────
export function emitContractVerifierResultParseFailed(
  audit: AuditLog,
  opts: { agentId: string; clawId: string; stage: string; reason: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_RESULT_PARSE_FAILED,
    `agentId=${opts.agentId}`,
    `clawId=${opts.clawId}`,
    `stage=${opts.stage}`,
    `reason=${opts.reason}`,
  );
}

// ─── OBSERVER_EVENT_FAILED ────────────────────────────────────────────────────
export function emitContractObserverEventFailed(
  audit: AuditLog,
  opts: { path: string; reason: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
    `path=${opts.path}`,
    `reason=${opts.reason}`,
  );
}

// ─── CONTRACT_COMPLETED_HANDLER_FAILED ────────────────────────────────────────
export function emitContractCompletedHandlerFailed(
  audit: AuditLog,
  opts: { contractId: string; error: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_COMPLETED_HANDLER_FAILED,
    `contractId=${opts.contractId}`,
    `error=${opts.error}`,
  );
}

// ─── EVENT_COLLECTOR_SCAN_FAILED ──────────────────────────────────────────────
export function emitContractEventCollectorScanFailed(
  audit: AuditLog,
  opts: { path: string; reason: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED,
    `path=${opts.path}`,
    `reason=${opts.reason}`,
  );
}

// ─── CONTRACT_DIR_SCAN_FAILED ─────────────────────────────────────────────────
export function emitContractContractDirScanFailed(
  audit: AuditLog,
  opts: { dir: string; code: string; error: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
    `dir=${opts.dir}`,
    `code=${opts.code}`,
    `error=${opts.error}`,
  );
}

// ─── OBSERVER_STATE_LOAD_FAILED ───────────────────────────────────────────────
export function emitContractObserverStateLoadFailed(
  audit: AuditLog,
  opts: { path: string; reason: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
    `path=${opts.path}`,
    `reason=${opts.reason}`,
  );
}

// ─── Legacy helper: format error ──────────────────────────────────────────────
export { formatErr };
