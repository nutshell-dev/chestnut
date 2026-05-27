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
import type { ClawId } from '../../foundation/identity/index.js';
import type { ContractId, SubtaskId } from './types.js';



// ─── phase 1235 B.3: invariant assert for empty contractId ─────────────────
function assertContractIdNonEmpty(
  audit: AuditLog,
  contractId: string | undefined,
  emitFnName: string,
): boolean {
  if (contractId === undefined) return true;
  if (contractId === '') {
    audit.write(
      CONTRACT_AUDIT_EVENTS.TYPED_EMIT_INVARIANT_VIOLATION,
      `field=contractId`,
      `event=${emitFnName}`,
      `reason=empty_string`,
    );
    return false;
  }
  return true;
}

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

// ─── LOCK_RETRY ─────────────────────────────────────────────────────────────
export function emitContractLockRetry(
  audit: AuditLog,
  opts: {
    attempt: number;
    max_retries: number;
    reason: string;
    delay_ms: number;
  },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.LOCK_RETRY,
    `attempt=${opts.attempt}/${opts.max_retries}`,
    `reason=${opts.reason}`,
    `delay_ms=${opts.delay_ms}`,
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
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractProgressSchemaInvalid')) return;
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
    contractId: ContractId;
    path: string;
    reason?: string;
    actual?: string;
    current?: number;
    raw?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractYamlSchemaInvalid')) return;
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
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractProgressCorrupted')) return;
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
  opts: { contractId: ContractId; error: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractRollbackFailed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.ROLLBACK_FAILED,
    `contractId=${opts.contractId}`,
    `error=${opts.error}`,
  );
}

// ─── ROLLBACK_INCOMPLETE ────────────────────────────────────────────────────
export function emitContractRollbackIncomplete(
  audit: AuditLog,
  opts: { contractId: ContractId; remaining: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractRollbackIncomplete')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.ROLLBACK_INCOMPLETE,
    `contractId=${opts.contractId}`,
    `remaining=${opts.remaining}`,
  );
}

// ─── CREATED ────────────────────────────────────────────────────────────────
export function emitContractCreated(
  audit: AuditLog,
  opts: { contractId: ContractId; subtasks: number; title: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCreated')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CREATED,
    opts.contractId,
    `subtasks=${opts.subtasks}`,
    `title=${opts.title}`,
  );
}

// ─── VERIFICATION_STARTED ─────────────────────────────────────────────────────
export function emitContractVerificationStarted(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationStarted')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── UPDATED ────────────────────────────────────────────────────────────────
export function emitContractUpdated(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; status: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractUpdated')) return;
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

// ─── VERIFICATION_INBOX_FAILED ────────────────────────────────────────────────
export function emitContractVerificationInboxFailed(
  audit: AuditLog,
  opts: { context?: string; error: string },
): void {
  const cols: string[] = [];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_INBOX_FAILED, ...cols);
}

// ─── VERIFICATION_RESET_FAILED ────────────────────────────────────────────────
export function emitContractVerificationResetFailed(
  audit: AuditLog,
  opts: {
    contractId?: string;
    subtaskId?: string;
    context?: string;
    message?: string;
    error?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationResetFailed')) return;
  const cols: string[] = [];
  if (opts.contractId !== undefined) cols.push(opts.contractId);
  if (opts.subtaskId !== undefined) cols.push(`subtaskId=${opts.subtaskId}`);
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.message !== undefined) cols.push(`message=${opts.message}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED, ...cols);
}

// ─── VERIFICATION_BACKGROUND_FAILED ───────────────────────────────────────────
export function emitContractVerificationBackgroundFailed(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; error: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationBackgroundFailed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_FAILED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `error=${opts.error}`,
  );
}

// ─── COMPLETE_ON_CANCELLED ──────────────────────────────────────────────────
export function emitContractCompleteOnCancelled(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; context?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCompleteOnCancelled')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  ];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  audit.write(CONTRACT_AUDIT_EVENTS.COMPLETE_ON_CANCELLED, ...cols);
}

// ─── VERIFICATION_BACKGROUND_DONE ─────────────────────────────────────────────
export function emitContractVerificationBackgroundDone(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; result: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationBackgroundDone')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `result=${opts.result}`,
  );
}

// ─── VERIFICATION_SCRIPT_STARTED ──────────────────────────────────────────────
export function emitContractVerificationScriptStarted(
  audit: AuditLog,
  opts: { script: string; cwd: string },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFICATION_SCRIPT_STARTED,
    `script=${opts.script}`,
    `cwd=${opts.cwd}`,
  );
}

// ─── SUBTASK_DUPLICATE_DONE ─────────────────────────────────────────────────
export function emitContractSubtaskDuplicateDone(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractSubtaskDuplicateDone')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_DUPLICATE_DONE,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── SUBTASK_ALREADY_COMPLETED ──────────────────────────────────────────────
export function emitContractSubtaskAlreadyCompleted(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractSubtaskAlreadyCompleted')) return;
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
    contractId: ContractId;
    subtaskId?: string;
    errorType?: string;
    error: string;
    stack?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractUnexpectedAsyncThrow')) return;
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
  opts: { contractId: ContractId; subtaskId: SubtaskId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractPassed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.PASSED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  );
}

// ─── CANCELLED ──────────────────────────────────────────────────────────────
export function emitContractCancelled(
  audit: AuditLog,
  opts: { contractId: ContractId; reason?: string; abortVerifierFailed?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCancelled')) return;
  const cols: string[] = [opts.contractId];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.abortVerifierFailed !== undefined) cols.push(`abort_verifier_failed=${opts.abortVerifierFailed}`);
  audit.write(CONTRACT_AUDIT_EVENTS.CANCELLED, ...cols);
}

// ─── COMPLETED ──────────────────────────────────────────────────────────────
export function emitContractCompleted(
  audit: AuditLog,
  opts: { contractId: ContractId; title: string; claw: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCompleted')) return;
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
  opts: { contractId: ContractId; checkpoint: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractPaused')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.PAUSED,
    opts.contractId,
    `checkpoint=${opts.checkpoint}`,
  );
}

// ─── RESUMED ────────────────────────────────────────────────────────────────
export function emitContractResumed(
  audit: AuditLog,
  opts: { contractId: ContractId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractResumed')) return;
  audit.write(CONTRACT_AUDIT_EVENTS.RESUMED, opts.contractId);
}

// ─── SUBTASK_COMPLETED (key-fix site: split ${contractId}/${subtaskId}) ─────
export function emitContractSubtaskCompleted(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; progress: string; claw: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractSubtaskCompleted')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `progress=${opts.progress}`,
    `claw=${opts.claw}`,
  );
}

// ─── VERIFICATION_FAILED (key-fix site: split ${contractId}/${subtaskId}) ─────
export function emitContractVerificationFailed(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; feedback?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationFailed')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
  ];
  if (opts.feedback !== undefined) cols.push(`feedback=${opts.feedback}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED, ...cols);
}

// ─── ESCALATED (key-fix site: split ${contractId}/${subtaskId}) ─────────────
export function emitContractEscalated(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    subtaskId: SubtaskId;
    retryCount: number;
    claw: string;
    context?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractEscalated')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `retry_count=${opts.retryCount}`,
    `claw=${opts.claw}`,
  ];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  audit.write(CONTRACT_AUDIT_EVENTS.ESCALATED, ...cols);
}

// ─── VERIFICATION_TIMEOUT (key-fix site: split ${contractId}/${subtaskId}) ────
export function emitContractVerificationTimeout(
  audit: AuditLog,
  opts: { contractId: ContractId; subtaskId: SubtaskId; claw: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationTimeout')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFICATION_TIMEOUT,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `claw=${opts.claw}`,
  );
}

// ─── VERIFIER_FAILED ──────────────────────────────────────────────────────────
export function emitContractVerifierFailed(
  audit: AuditLog,
  opts: { contractId: ContractId; agentId?: string; clawId?: string; kind?: string; reason?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierFailed')) return;
  const cols: string[] = [`contractId=${opts.contractId}`];
  if (opts.agentId !== undefined) cols.push(`agentId=${opts.agentId}`);
  if (opts.clawId !== undefined) cols.push(`clawId=${opts.clawId}`);
  if (opts.kind !== undefined) cols.push(`kind=${opts.kind}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED, ...cols);
}

// ─── VERIFIER_SKIPPED ─────────────────────────────────────────────────────────
export function emitContractVerifierSkipped(
  audit: AuditLog,
  opts: { contractId: ContractId; agentId: string; reason: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierSkipped')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED,
    `contractId=${opts.contractId}`,
    `agentId=${opts.agentId}`,
    `reason=${opts.reason}`,
  );
}

// ─── VERIFIER_STARTED ─────────────────────────────────────────────────────────
export function emitContractVerifierStarted(
  audit: AuditLog,
  opts: { contractId: ContractId; agentId: string; clawId: ClawId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierStarted')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_STARTED,
    `contractId=${opts.contractId}`,
    `agentId=${opts.agentId}`,
    `clawId=${opts.clawId}`,
  );
}

// ─── VERIFIER_PASSED ──────────────────────────────────────────────────────────
export function emitContractVerifierPassed(
  audit: AuditLog,
  opts: { contractId: ContractId; agentId: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierPassed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED,
    `contractId=${opts.contractId}`,
    `agentId=${opts.agentId}`,
  );
}

// ─── VERIFIER_RESULT_PARSE_FAILED ─────────────────────────────────────────────
export function emitContractVerifierResultParseFailed(
  audit: AuditLog,
  opts: { contractId: ContractId; agentId: string; clawId: ClawId; stage: string; reason: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierResultParseFailed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_RESULT_PARSE_FAILED,
    `contractId=${opts.contractId}`,
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
  opts: { contractId: ContractId; error: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCompletedHandlerFailed')) return;
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
