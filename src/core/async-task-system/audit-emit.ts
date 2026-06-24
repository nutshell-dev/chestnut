/**
 * @module L4.AsyncTaskSystem.AuditEmit
 * Typed audit emit functions for async-task-system.
 *
 * Per-event typed payload enforces phase 706 audit key naming decision tree
 * (business ID typed camelCase: taskId= / toolName= / toolUseId=).
 * Zero audit row format change — typed emit serializes bit-identical to string col.
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import type { TaskId } from './types.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';



// ─── TASK_SCHEDULED ───────────────────────────────────────────────────────────
export function emitTaskScheduled(
  audit: AuditLog,
  opts: {
    taskId: TaskId;
    kind: string;
    parent?: string;
    maxSteps?: number;
    tool?: string;
    isShadow?: boolean;
  },
): void {
  const cols: (string | number)[] = [`taskId=${opts.taskId}`, `kind=${opts.kind}`];
  if (opts.parent !== undefined) cols.push(`parent=${opts.parent}`);
  if (opts.maxSteps !== undefined) cols.push(`maxSteps=${opts.maxSteps}`);
  if (opts.tool !== undefined) cols.push(`tool=${opts.tool}`);
  if ('isShadow' in opts) cols.push(`isShadow=${opts.isShadow}`);
  audit.write(TASK_AUDIT_EVENTS.TASK_SCHEDULED, ...cols);
}

// ─── TASK_STARTED ─────────────────────────────────────────────────────────────
export function emitTaskStarted(
  audit: AuditLog,
  opts: { taskId: TaskId },
): void {
  audit.write(TASK_AUDIT_EVENTS.TASK_STARTED, `taskId=${opts.taskId}`);
}

// ─── TASK_COMPLETED ───────────────────────────────────────────────────────────
export function emitTaskCompleted(
  audit: AuditLog,
  opts: {
    taskId: TaskId;
    status: 'ok' | 'err';
    kind: string;
    parent?: string;
    callerType?: string;
    intent?: string;
    elapsedMs?: number;
    len?: number;
    subAuditPath?: string;
    toolName?: string;
    retries?: number;
    errorCategory?: string;
  },
): void {
  // phase 706: raw status 加 key= prefix、与同 fn 其他 cols 统一形态、forensic 可 join status 维度
  const cols: (string | number)[] = [
    `taskId=${opts.taskId}`,
    `status=${opts.status}`,
    `kind=${opts.kind}`,
  ];
  if (opts.parent !== undefined) cols.push(`parent=${opts.parent}`);
  if (opts.callerType !== undefined) cols.push(`callerType=${opts.callerType}`);
  if (opts.intent !== undefined) cols.push(`intent=${opts.intent}`);
  if (opts.errorCategory !== undefined) cols.push(`error_category=${opts.errorCategory}`);
  if (opts.elapsedMs !== undefined) cols.push(`elapsed_ms=${opts.elapsedMs}`);
  if (opts.len !== undefined) cols.push(`len=${opts.len}`);
  if (opts.subAuditPath !== undefined) cols.push(`subAuditPath=${opts.subAuditPath}`);
  if (opts.toolName !== undefined) cols.push(`toolName=${opts.toolName}`);
  if (opts.retries !== undefined) cols.push(`retries=${opts.retries}`);
  audit.write(TASK_AUDIT_EVENTS.TASK_COMPLETED, ...cols);
}

// ─── PENDING_INGEST_FAILED ────────────────────────────────────────────────────
export function emitPendingIngestFailed(
  audit: AuditLog,
  opts: {
    taskId?: string;
    context?: string;
    path?: string;
    error: string;
  },
): void {
  const cols: (string | number)[] = [];
  if (opts.taskId !== undefined) cols.push(`taskId=${opts.taskId}`);
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.path !== undefined) cols.push(`path=${opts.path}`);
  cols.push(`error=${opts.error}`);
  audit.write(TASK_AUDIT_EVENTS.PENDING_INGEST_FAILED, ...cols);
}

// ─── PENDING_QUEUE_OVERFLOW ───────────────────────────────────────────────────
export function emitPendingQueueOverflow(
  audit: AuditLog,
  opts: { taskId: TaskId; queueLength: number; cap: number },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW,
    `taskId=${opts.taskId}`,
    `queueLength=${opts.queueLength}`,
    `cap=${opts.cap}`,
  );
}

// ─── PENDING_QUEUE_OVERFLOW_NOTIFIED ──────────────────────────────────────────
export function emitPendingQueueOverflowNotified(
  audit: AuditLog,
  opts: { taskId: TaskId; queueLength: number; cap: number },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.PENDING_QUEUE_OVERFLOW_NOTIFIED,
    `taskId=${opts.taskId}`,
    `queueLength=${opts.queueLength}`,
    `cap=${opts.cap}`,
  );
}

// ─── PENDING_WATCHER_FAILED / PENDING_WATCHER_CALLBACK_FAILED ─────────────────
export function emitPendingWatcherFailed(
  audit: AuditLog,
  opts: { event: typeof TASK_AUDIT_EVENTS.PENDING_WATCHER_FAILED | typeof TASK_AUDIT_EVENTS.PENDING_WATCHER_CALLBACK_FAILED; path: string; context: string; reason: string },
): void {
  audit.write(opts.event, `path=${opts.path}`, `context=${opts.context}`, `reason=${opts.reason}`);
}

// ─── RECOVERED ────────────────────────────────────────────────────────────────
export function emitRecovered(
  audit: AuditLog,
  opts: {
    taskId: TaskId;
    kind?: string;
    from?: string;
    to?: string;
    reason?: string;
  },
): void {
  const cols: (string | number)[] = [`taskId=${opts.taskId}`];
  if (opts.kind !== undefined) cols.push(`kind=${opts.kind}`);
  if (opts.from !== undefined) cols.push(`from=${opts.from}`);
  if (opts.to !== undefined) cols.push(`to=${opts.to}`);
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  audit.write(TASK_AUDIT_EVENTS.RECOVERED, ...cols);
}

// ─── RECOVERY_COMPLETE ────────────────────────────────────────────────────────
export function emitRecoveryComplete(
  audit: AuditLog,
  opts: { pending: number; recoveredRunning: number; failed: number },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.RECOVERY_COMPLETE,
    'system',
    `pending=${opts.pending}`,
    `recovered_running=${opts.recoveredRunning}`,
    `failed=${opts.failed}`,
  );
}

// ─── RECOVERY_FAILED ──────────────────────────────────────────────────────────
export function emitRecoveryFailed(
  audit: AuditLog,
  opts: {
    taskId?: string;
    path?: string;
    source?: string;
    context: string;
    error?: string;
    raw?: string;
    retryCount?: number;
    maxRetries?: number;
  },
): void {
  const cols: (string | number)[] = [];
  if (opts.taskId !== undefined) cols.push(`taskId=${opts.taskId}`);
  if (opts.path !== undefined) cols.push(`path=${opts.path}`);
  if (opts.source !== undefined) cols.push(`source=${opts.source}`);
  cols.push(`context=${opts.context}`);
  if (opts.raw !== undefined) cols.push(`raw=${opts.raw}`);
  if (opts.retryCount !== undefined) cols.push(`retryCount=${opts.retryCount}`);
  if (opts.maxRetries !== undefined) cols.push(`maxRetries=${opts.maxRetries}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, ...cols);
}

// ─── RECOVERY_DEAD_LETTER ─────────────────────────────────────────────────────
export function emitRecoveryDeadLetter(
  audit: AuditLog,
  opts: { taskId: TaskId; retries: number },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER,
    `taskId=${opts.taskId}`,
    `retries=${opts.retries}`,
    'action=move_to_failed',
  );
}

// ─── START_FAILED ─────────────────────────────────────────────────────────────
export function emitStartFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; context?: string; error: string },
): void {
  const cols: (string | number)[] = [`taskId=${opts.taskId}`];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  cols.push(`error=${opts.error}`);
  audit.write(TASK_AUDIT_EVENTS.START_FAILED, ...cols);
}

// ─── HANDLER_FAILED ───────────────────────────────────────────────────────────
export function emitHandlerFailed(
  audit: AuditLog,
  opts: {
    taskId: TaskId;
    context?: string;
    error?: string;
    parent?: string;
    name?: string;
    tool?: string;
  },
): void {
  const cols: (string | number)[] = [`taskId=${opts.taskId}`];
  if (opts.tool !== undefined) cols.push(`tool=${opts.tool}`);
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  if (opts.name !== undefined) cols.push(`name=${opts.name}`);
  if (opts.parent !== undefined) cols.push(`parent=${opts.parent}`);
  if (opts.error !== undefined) cols.push(`error=${opts.error}`);
  audit.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, ...cols);
}

// ─── RESULT_WRITE_FAILED ──────────────────────────────────────────────────────
export function emitResultWriteFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; context: string; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED,
    `taskId=${opts.taskId}`,
    `context=${opts.context}`,
    `error=${opts.error}`,
  );
}

// ─── INBOX_WRITE_FAILED ───────────────────────────────────────────────────────
export function emitInboxWriteFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; context?: string; error: string },
): void {
  const cols: (string | number)[] = [`taskId=${opts.taskId}`];
  if (opts.context !== undefined) cols.push(`context=${opts.context}`);
  cols.push(`error=${opts.error}`);
  audit.write(TASK_AUDIT_EVENTS.INBOX_WRITE_FAILED, ...cols);
}

// ─── SHUTDOWN_TIMEOUT ─────────────────────────────────────────────────────────
export function emitShutdownTimeout(audit: AuditLog): void {
  audit.write(TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT);
}

// ─── MOVE_FAILED ──────────────────────────────────────────────────────────────
export function emitMoveFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; context: string; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.MOVE_FAILED,
    `taskId=${opts.taskId}`,
    `context=${opts.context}`,
    `error=${opts.error}`,
  );
}

// ─── TASK_CANCEL_RACE_LOST_TO_DISPATCH ────────────────────────────────────────
export function emitTaskCancelRaceLostToDispatch(
  audit: AuditLog,
  opts: { taskId: TaskId },
): void {
  audit.write(TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH, `taskId=${opts.taskId}`);
}

// ─── CANCELLED ────────────────────────────────────────────────────────────────
export function emitCancelled(
  audit: AuditLog,
  opts: { taskId: TaskId; from: string },
): void {
  audit.write(TASK_AUDIT_EVENTS.CANCELLED, `taskId=${opts.taskId}`, `from=${opts.from}`);
}

// ─── TOOL_RETRY ───────────────────────────────────────────────────────────────
export function emitToolRetry(
  audit: AuditLog,
  opts: { taskId: TaskId; tool: string; attempt: number; max: number; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.TOOL_RETRY,
    `taskId=${opts.taskId}`,
    `tool=${opts.tool}`,
    `attempt=${opts.attempt}`,
    `max=${opts.max}`,
    `error=${opts.error}`,
  );
}

// ─── TOOL_ASYNC_RESULT ────────────────────────────────────────────────────────
export function emitToolAsyncResult(
  audit: AuditLog,
  opts: { taskId: TaskId; toolName: string; toolUseId: ToolUseId },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.TOOL_ASYNC_RESULT,
    `tool_name=${opts.toolName}`,
    `tool_use_id=${String(opts.toolUseId)}`,
    `task_id=${opts.taskId}`,
  );
}

// ─── SHUTDOWN_PENDING_CLEANUPS_DRAINED ────────────────────────────────────────
export function emitShutdownPendingCleanupsDrained(audit: AuditLog): void {
  audit.write(TASK_AUDIT_EVENTS.SHUTDOWN_PENDING_CLEANUPS_DRAINED);
}

// ─── TASK_CORRUPT ─────────────────────────────────────────────────────────────
export function emitTaskCorrupt(
  audit: AuditLog,
  opts: { backup: string; moveOk: boolean; moveError?: string; error: string },
): void {
  const cols: (string | number)[] = [
    `backup=${opts.backup}`,
    `move_ok=${opts.moveOk}`,
  ];
  if (!opts.moveOk && opts.moveError !== undefined) {
    cols.push(`move_error=${opts.moveError}`);
  }
  cols.push(`error=${opts.error}`);
  audit.write(TASK_AUDIT_EVENTS.TASK_CORRUPT, ...cols);
}

// ─── CANCEL_PROMISE_REJECTED ──────────────────────────────────────────────────
export function emitCancelPromiseRejected(
  audit: AuditLog,
  opts: { taskId: TaskId; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
    `taskId=${opts.taskId}`,
    `error=${opts.error}`,
  );
}

// ─── RESULT_DELIVERY_ENSURE_DIR_FAILED ────────────────────────────────────────
export function emitResultDeliveryEnsureDirFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; dir: string; code: string; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.RESULT_DELIVERY_ENSURE_DIR_FAILED,
    `taskId=${opts.taskId}`,
    `dir=${opts.dir}`,
    `code=${opts.code}`,
    `error=${opts.error}`,
  );
}

// ─── PARSE_FAILED ─────────────────────────────────────────────────────────────
export function emitParseFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; context: string; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.PARSE_FAILED,
    `taskId=${opts.taskId}`,
    `context=${opts.context}`,
    `error=${opts.error}`,
  );
}

// ─── RESULT_DELIVERY_FAILED ───────────────────────────────────────────────────
export function emitResultDeliveryFailed(
  audit: AuditLog,
  opts: { taskId: TaskId; reason: string; error: string },
): void {
  audit.write(
    TASK_AUDIT_EVENTS.RESULT_DELIVERY_FAILED,
    `taskId=${opts.taskId}`,
    `reason=${opts.reason}`,
    `error=${opts.error}`,
  );
}

// ─── Legacy helper: format error and emit ─────────────────────────────────────
// Re-export formatErr for callers that need to format errors before typed emit.
export { formatErr };
