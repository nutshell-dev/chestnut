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
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { ContractId } from './types.js';
import type { SubtaskId } from './types.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';



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

// ─── MISSING_STARTED_AT (Phase 1194 Step A) ─────────────────────────────────
export function emitContractMissingStartedAt(
  audit: AuditLog,
  opts: { context: string; contractId: ContractId; reason: 'missing_started_at' },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractMissingStartedAt')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.MISSING_STARTED_AT,
    `context=${opts.context}`,
    `contractId=${opts.contractId}`,
    `reason=${opts.reason}`,
  );
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
    error?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractYamlSchemaInvalid')) return;
  const cols: string[] = [`contractId=${opts.contractId}`, `path=${opts.path}`];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.actual !== undefined) cols.push(`actual=${opts.actual}`);
  if (opts.current !== undefined) cols.push(`current=${opts.current}`);
  if (opts.raw !== undefined) cols.push(`raw=${opts.raw}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID, ...cols);
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

// ─── CREATED ────────────────────────────────────────────────────────────────
export function emitContractCreated(
  audit: AuditLog,
  opts: { contractId: ContractId; subtasks: number; title: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCreated')) return;
  // phase 705: contractId 加 key= prefix、与同模块其他 emit (PASSED/UPDATED 等) 形态对齐
  audit.write(
    CONTRACT_AUDIT_EVENTS.CREATED,
    `contractId=${opts.contractId}`,
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
  // phase 704: 加 contractId= prefix、与同 fn cols 统一形态、forensic 解析可 join contractId 维度
  if (opts.contractId !== undefined) cols.push(`contractId=${opts.contractId}`);
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
  opts: { contractId: ContractId; subtaskId: SubtaskId; result: string; cancelReason?: string; missingSubtaskId?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerificationBackgroundDone')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `result=${opts.result}`,
  ];
  if (opts.cancelReason !== undefined) cols.push(`cancel_reason=${opts.cancelReason}`);
  if (opts.missingSubtaskId !== undefined) cols.push(`missing_subtask_id=${opts.missingSubtaskId}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE, ...cols);
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

// ─── CORRUPTED (phase 1121 Step C) ──────────────────────────────────────────
export function emitContractCorrupted(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    reason: string;
    evidencePath: string;
    abortVerifierFailed?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCorrupted')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `reason=${opts.reason}`,
    `evidence_path=${opts.evidencePath}`,
  ];
  if (opts.abortVerifierFailed !== undefined) cols.push(`abort_verifier_failed=${opts.abortVerifierFailed}`);
  audit.write(CONTRACT_AUDIT_EVENTS.CORRUPTED, ...cols);
}

// ─── CANCELLED ──────────────────────────────────────────────────────────────
export function emitContractCancelled(
  audit: AuditLog,
  opts: { contractId: ContractId; reason?: string; abortVerifierFailed?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCancelled')) return;
  // phase 705: contractId 加 key= prefix、与同模块其他 emit 形态对齐
  const cols: string[] = [`contractId=${opts.contractId}`];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  if (opts.abortVerifierFailed !== undefined) cols.push(`abort_verifier_failed=${opts.abortVerifierFailed}`);
  audit.write(CONTRACT_AUDIT_EVENTS.CANCELLED, ...cols);
}

// ─── FAILED (Phase 1396 Step D) ─────────────────────────────────────────────
export function emitContractFailed(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    reason: string;
    evidenceRef: string;
    producer: string;
    abortVerifierFailed?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractFailed')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `reason=${opts.reason}`,
    `evidence_ref=${opts.evidenceRef}`,
    `producer=${opts.producer}`,
  ];
  if (opts.abortVerifierFailed !== undefined) cols.push(`abort_verifier_failed=${opts.abortVerifierFailed}`);
  audit.write(CONTRACT_AUDIT_EVENTS.FAILED, ...cols);
}

// ─── COMPLETED ──────────────────────────────────────────────────────────────
export function emitContractCompleted(
  audit: AuditLog,
  opts: { contractId: ContractId; title: string; claw: string; abortVerifierFailed?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCompleted')) return;
  // phase 705: contractId 加 key= prefix、与同模块其他 emit 形态对齐
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `title=${opts.title}`,
    `claw=${opts.claw}`,
  ];
  if (opts.abortVerifierFailed !== undefined) cols.push(`abort_verifier_failed=${opts.abortVerifierFailed}`);
  audit.write(CONTRACT_AUDIT_EVENTS.COMPLETED, ...cols);
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

// ─── SUBTASK_RESET_TO_TODO ────────────────────────────────────────────────────
// phase 425: handleVerificationErrorRetry 内 retry path saveProgress 之后 audit。
// 替原 polling `waitFor(... status !== 'in_progress')` 模式、tests 可等此 event 知 state 已 settle。
export function emitContractSubtaskResetToTodo(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    subtaskId: SubtaskId;
    cause: string;
    retryCount: number;
    maxAttempts: number;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractSubtaskResetToTodo')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `cause=${opts.cause}`,
    `retry_count=${opts.retryCount}`,
    `max_attempts=${opts.maxAttempts}`,
  );
}

// ─── SUBTASK_FORCE_ACCEPTED (key-fix site: split ${contractId}/${subtaskId}) ─────────────
export function emitSubtaskForceAccepted(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    subtaskId: SubtaskId;
    retryCount: number;
    claw: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitSubtaskForceAccepted')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED,
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `retry_count=${opts.retryCount}`,
    `claw=${opts.claw}`,
  );
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

// ─── VERIFIER_REGISTERED ──────────────────────────────────────────────────────
// phase 376: 控制器注册 audit、tests 用此 event 等待 verifier 起步（替原 polling getActiveVerifierCount）
export function emitContractVerifierRegistered(
  audit: AuditLog,
  opts: { contractId: ContractId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierRegistered')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED,
    `contractId=${opts.contractId}`,
  );
}

// ─── VERIFIER_UNREGISTERED ────────────────────────────────────────────────────
// phase 376: 控制器注销 audit
export function emitContractVerifierUnregistered(
  audit: AuditLog,
  opts: { contractId: ContractId },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractVerifierUnregistered')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFIER_UNREGISTERED,
    `contractId=${opts.contractId}`,
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

// ─── ARCHIVE_RECONCILE_STALE ────────────────────────────────────────────────
export function emitContractArchiveReconcileStale(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    contractId: string;
    oldStatus: string;
    newStatus: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractArchiveReconcileStale')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_STALE,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `oldStatus=${opts.oldStatus}`,
    `newStatus=${opts.newStatus}`,
  );
}

// ─── ARCHIVE_RECONCILE_FAILED ─────────────────────────────────────────────────
export function emitContractArchiveReconcileFailed(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    contractId: string;
    context: string;
    error: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractArchiveReconcileFailed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_FAILED,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `context=${opts.context}`,
    `error=${opts.error}`,
  );
}

// ─── ARCHIVE_RECONCILE_SUMMARY ────────────────────────────────────────────────
export function emitContractArchiveReconcileSummary(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    scanned: number;
    swept: number;
    failed: number;
  },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_RECONCILE_SUMMARY,
    `clawId=${opts.clawId}`,
    `scanned=${opts.scanned}`,
    `swept=${opts.swept}`,
    `failed=${opts.failed}`,
  );
}

// ─── ARCHIVE LEGACY MIGRATION ─────────────────────────────────────────────────
// phase 1127 Step E: classified legacy flat entry migrated to state subdirectory
export function emitContractArchiveLegacyMigrated(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    contractId: string;
    fromPath: string;
    toPath: string;
    evidence: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractArchiveLegacyMigrated')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATED,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `from=${opts.fromPath}`,
    `to=${opts.toPath}`,
    `evidence=${opts.evidence}`,
  );
}

export function emitContractArchiveLegacyMigrationConflict(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    contractId: string;
    targetPath: string;
    evidence: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractArchiveLegacyMigrationConflict')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_CONFLICT,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `targetPath=${opts.targetPath}`,
    `evidence=${opts.evidence}`,
  );
}

export function emitContractArchiveLegacyMigrationSkipped(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    contractId: string;
    reason: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractArchiveLegacyMigrationSkipped')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_SKIPPED,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `reason=${opts.reason}`,
  );
}

export function emitContractArchiveLegacyMigrationFailed(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    contractId: string;
    context: string;
    error: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractArchiveLegacyMigrationFailed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_FAILED,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `context=${opts.context}`,
    `error=${opts.error}`,
  );
}

export function emitContractArchiveLegacyMigrationSummary(
  audit: AuditLog,
  opts: {
    clawId: ClawId;
    scanned: number;
    migrated: number;
    conflicts: number;
    skipped: number;
    failed: number;
  },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_LEGACY_MIGRATION_SUMMARY,
    `clawId=${opts.clawId}`,
    `scanned=${opts.scanned}`,
    `migrated=${opts.migrated}`,
    `conflicts=${opts.conflicts}`,
    `skipped=${opts.skipped}`,
    `failed=${opts.failed}`,
  );
}

// ─── CONTRACT_CREATE_POLICY_REJECTED ────────────────────────────────────────
export function emitContractCreatePolicyRejected(
  audit: AuditLog,
  payload: { policyName: string; cause: string; details?: Record<string, unknown> },
): void {
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_CREATE_POLICY_REJECTED,
    `policyName=${payload.policyName}`,
    `cause=${payload.cause}`,
    ...(payload.details !== undefined ? [`details=${JSON.stringify(payload.details)}`] : []),
  );
}

// ─── LEGACY_CRASHED_OBSERVED (phase 1121 Step D) ────────────────────────────
export function emitContractLegacyCrashedObserved(
  audit: AuditLog,
  opts: {
    clawId: string;
    contractId: string;
    sourcePath: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractLegacyCrashedObserved')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_CRASHED_OBSERVED,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `source_path=${opts.sourcePath}`,
    `status=legacy_crashed`,
  );
}

// ─── LEGACY_PAUSED_OBSERVED (phase 1123 Step D) ─────────────────────────────
export function emitContractLegacyPausedObserved(
  audit: AuditLog,
  opts: {
    clawId: string;
    contractId: string;
    sourcePath: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractLegacyPausedObserved')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_PAUSED_OBSERVED,
    `clawId=${opts.clawId}`,
    `contractId=${opts.contractId}`,
    `source_path=${opts.sourcePath}`,
    `status=legacy_paused`,
  );
}

// ─── CONTRACT_CREATION (Phase 1197) ─────────────────────────────────────────
export function emitContractCreationClaimed(
  audit: AuditLog,
  opts: { contractId: ContractId; startedAt: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCreationClaimed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_CLAIMED,
    `contractId=${opts.contractId}`,
    `started_at=${opts.startedAt}`,
  );
}

export function emitContractCreationInterrupted(
  audit: AuditLog,
  opts: { contractId: ContractId; startedAt: string; boundary: string; error: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitContractCreationInterrupted')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_INTERRUPTED,
    `contractId=${opts.contractId}`,
    `started_at=${opts.startedAt}`,
    `boundary=${opts.boundary}`,
    `error=${opts.error}`,
  );
}

// ─── LIFECYCLE_INTENT (Phase 1198 Step A) ───────────────────────────────────
export function emitLifecycleIntentPersisted(
  audit: AuditLog,
  opts: { contractId: ContractId; requestId: string; requestedState: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitLifecycleIntentPersisted')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_PERSISTED,
    `contractId=${opts.contractId}`,
    `requestId=${opts.requestId}`,
    `requested_state=${opts.requestedState}`,
  );
}

export function emitLifecycleIntentReadIssue(
  audit: AuditLog,
  opts: { contractId: string; requestId: string; reason: string; detail?: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitLifecycleIntentReadIssue')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `requestId=${opts.requestId}`,
    `reason=${opts.reason}`,
  ];
  if (opts.detail !== undefined) cols.push(`detail=${opts.detail}`);
  audit.write(CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE, ...cols);
}

// ─── PROGRESS_MUTATION queue (Phase 1201 Step A) ────────────────────────────
// depth 是 observability metadata、非 authority。
interface ProgressMutationEmitPayload {
  contractId: ContractId;
  mutationId: string;
  kind: string;
  depth: number;
}

function progressMutationCols(opts: ProgressMutationEmitPayload): string[] {
  return [
    `contractId=${opts.contractId}`,
    `mutationId=${opts.mutationId}`,
    `kind=${opts.kind}`,
    `depth=${opts.depth}`,
  ];
}

export function emitProgressMutationQueued(
  audit: AuditLog,
  opts: ProgressMutationEmitPayload,
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitProgressMutationQueued')) return;
  audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_QUEUED, ...progressMutationCols(opts));
}

export function emitProgressMutationStarted(
  audit: AuditLog,
  opts: ProgressMutationEmitPayload,
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitProgressMutationStarted')) return;
  audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_STARTED, ...progressMutationCols(opts));
}

export function emitProgressMutationFinished(
  audit: AuditLog,
  opts: ProgressMutationEmitPayload,
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitProgressMutationFinished')) return;
  audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_FINISHED, ...progressMutationCols(opts));
}

export function emitProgressMutationFailed(
  audit: AuditLog,
  opts: ProgressMutationEmitPayload & { error: string },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitProgressMutationFailed')) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.PROGRESS_MUTATION_FAILED,
    ...progressMutationCols(opts),
    `error=${opts.error}`,
  );
}

// ─── VERIFICATION_OUTCOME replay / late (Phase 1201 Step C) ─────────────────
export function emitVerificationOutcomeReplay(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    subtaskId: string;
    attemptId: string;
    outcomeKind: string;
    result: 'replayed' | 'already_applied' | 'superseded' | 'not_active' | 'invalid';
    detail?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitVerificationOutcomeReplay')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `attemptId=${opts.attemptId}`,
    `outcome_kind=${opts.outcomeKind}`,
    `result=${opts.result}`,
  ];
  if (opts.detail !== undefined) cols.push(`detail=${opts.detail}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_REPLAY, ...cols);
}

export function emitVerificationOutcomeLate(
  audit: AuditLog,
  opts: {
    contractId: ContractId;
    subtaskId: string;
    attemptId: string;
    outcomeKind: string;
    actualAttemptId?: string;
  },
): void {
  if (!assertContractIdNonEmpty(audit, opts.contractId, 'emitVerificationOutcomeLate')) return;
  const cols: string[] = [
    `contractId=${opts.contractId}`,
    `subtaskId=${opts.subtaskId}`,
    `attemptId=${opts.attemptId}`,
    `outcome_kind=${opts.outcomeKind}`,
    `result=superseded`,
  ];
  if (opts.actualAttemptId !== undefined) cols.push(`actual_attempt_id=${opts.actualAttemptId}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_LATE, ...cols);
}
