/**
 * @module L2c.Messaging.AuditEmit
 * Typed audit emit functions for messaging module (phase 1163 r128 E fork β-2,
 * phase 1210 cascade closure inbox-writer/reader).
 *
 * Per-event typed payload enforces phase 706 audit key naming decision tree
 * (camelCase typed col + business ID typed). Mirror phase 1127 snapshot/audit-emit.ts
 * + phase 1130 async-task-system + phase 1141 contract per-module typed emit cascade.
 */

import type { MessagingAuditSink } from './audit-sink.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import type { ClawId } from '../claw-identity/index.js';




// ─── INBOX_WRITTEN ────────────────────────────────────────────────────────────
// phase 1851 Step B: business-key opacity — messaging events record message
// identity (id/type) only; metadata stays opaque (producer owns correlation).
export function emitInboxWritten(
  audit: MessagingAuditSink,
  opts: { file: string; to?: string; id: string; type: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN,
    `file=${opts.file}`,
    `to=${opts.to ?? 'broadcast'}`,
    `id=${opts.id}`,
    `type=${opts.type}`,
  );
}

// ─── INBOX_WRITE_FAILED ───────────────────────────────────────────────────────
// phase 1851 Step B: business-key opacity — message identity only (id/type).
export function emitInboxWriteFailed(
  audit: MessagingAuditSink,
  opts: { file: string; to?: string; reason: string; id: string; type: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_WRITE_FAILED,
    `file=${opts.file}`,
    `to=${opts.to ?? 'broadcast'}`,
    `reason=${opts.reason}`,
    `id=${opts.id}`,
    `type=${opts.type}`,
  );
}

// ─── INBOX_BODY_OVERSIZE ──────────────────────────────────────────────────────
// phase 429 Step A (review medium): inbox body 超 cap、emit + caller 收 throw
// phase 933: wire size limit covers the encoded payload (body + metadata + extraFields)
// phase 1851 Step B: business-key opacity — message identity only (id/type).
export function emitInboxBodyOversize(
  audit: MessagingAuditSink,
  opts: {
    source: string;
    to?: string;
    id: string;
    type: string;
    bodySize: number;
    wireSize: number;
    cap: number;
  },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_BODY_OVERSIZE,
    `source=${opts.source}`,
    `to=${opts.to ?? 'broadcast'}`,
    `id=${opts.id}`,
    `type=${opts.type}`,
    `body_size=${opts.bodySize}`,
    `wire_size=${opts.wireSize}`,
    `cap=${opts.cap}`,
  );
}

// ─── INBOX_LIST_FAILED ────────────────────────────────────────────────────────
export function emitInboxListFailed(
  audit: MessagingAuditSink,
  opts: { dir: string; op?: string; errorCode?: string; reason: string },
): void {
  const cols: string[] = [`dir=${opts.dir}`];
  if (opts.op !== undefined) cols.push(`op=${opts.op}`);
  if (opts.errorCode !== undefined) cols.push(`error_code=${opts.errorCode}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_LIST_FAILED, ...cols);
}

// ─── INBOX_FAILED ─────────────────────────────────────────────────────────────
export function emitInboxFailed(
  audit: MessagingAuditSink,
  opts: { file: string; errorCode?: string; reason: string },
): void {
  const cols: string[] = [`file=${opts.file}`];
  if (opts.errorCode !== undefined) cols.push(`error_code=${opts.errorCode}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_FAILED, ...cols);
}

// ─── INBOX_PRIORITY_UNKNOWN ───────────────────────────────────────────────────
export function emitInboxPriorityUnknown(
  audit: MessagingAuditSink,
  opts: { file: string; original: string; fallback: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_PRIORITY_UNKNOWN, `file=${opts.file}`, `original=${opts.original}`, `fallback=${opts.fallback}`);
}

// ─── INBOX_LEGACY_CLAW_ID_FIELD ───────────────────────────────────────────────
export function emitInboxLegacyClawIdField(
  audit: MessagingAuditSink,
  opts: { file: string; clawId: ClawId },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_LEGACY_CLAW_ID_FIELD, `file=${opts.file}`, `claw_id=${opts.clawId}`);
}

// ─── INBOX_DEDUPED ────────────────────────────────────────────────────────────
// phase 849: dual-key task IDs — emit both short and full ID when available
// phase 1851 Step B: business-key opacity — taskId cols stay (dedupe key comes
// from the message content task protocol, not metadata); id/type recorded when
// the decoded message is available (recovery paths only know the file).
export function emitInboxDeduped(
  audit: MessagingAuditSink,
  opts: { file: string; shortTaskId?: string; fullTaskId?: string; id?: string; type?: string },
): void {
  const cols: string[] = [`file=${opts.file}`];
  // phase 849: dual-key IDs; keep legacy taskId= column for backward compatibility
  const legacyTaskId = opts.shortTaskId ?? opts.fullTaskId;
  if (legacyTaskId !== undefined) cols.push(`taskId=${legacyTaskId}`);
  if (opts.shortTaskId !== undefined) cols.push(`shortTaskId=${opts.shortTaskId}`);
  if (opts.fullTaskId !== undefined) cols.push(`fullTaskId=${opts.fullTaskId}`);
  if (opts.id !== undefined) cols.push(`id=${opts.id}`);
  if (opts.type !== undefined) cols.push(`type=${opts.type}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED, ...cols);
}

// ─── INBOX_MARK_DONE_FAILED ───────────────────────────────────────────────────
// phase 578: 加 file forensic col、forensic 解析能定位是哪个 file mark-done 失败
export function emitInboxMarkDoneFailed(
  audit: MessagingAuditSink,
  opts: { file: string; reason: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_MARK_DONE_FAILED, `file=${opts.file}`, `reason=${opts.reason}`);
}

// ─── INBOX_DONE ───────────────────────────────────────────────────────────────
export function emitInboxDone(
  audit: MessagingAuditSink,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_DONE, `file=${opts.file}`);
}

// ─── INBOX_MISROUTED (phase 442) ─────────────────────────────────────────────
export function emitInboxMisrouted(
  audit: MessagingAuditSink,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_MISROUTED, `file=${opts.file}`);
}

// ─── OUTBOX_DELIVERED ─────────────────────────────────────────────────────────
export function emitOutboxDelivered(
  audit: MessagingAuditSink,
  opts: { file: string; deliveredAt?: number },
): void {
  const cols: string[] = [`file=${opts.file}`];
  if (opts.deliveredAt !== undefined) {
    cols.push(`deliveredAt=${opts.deliveredAt}`);
  }
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_DELIVERED, ...cols);
}

// ─── OUTBOX_SKIPPED (phase 1748) ──────────────────────────────────────────────
// outbox-skip 不读内容直接归档、独立审计（区别于 delivered）
export function emitOutboxSkipped(
  audit: MessagingAuditSink,
  opts: { file: string; skippedAt?: number },
): void {
  const cols: string[] = [`file=${opts.file}`];
  if (opts.skippedAt !== undefined) {
    cols.push(`skippedAt=${opts.skippedAt}`);
  }
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_SKIPPED, ...cols);
}

// ─── INBOX_MOVE_FAILED ────────────────────────────────────────────────────────
export function emitInboxMoveFailed(
  audit: MessagingAuditSink,
  opts: { file: string; op: string; errorCode?: string; reason: string },
): void {
  const cols: string[] = [`file=${opts.file}`, `op=${opts.op}`];
  if (opts.errorCode !== undefined) cols.push(`error_code=${opts.errorCode}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_MOVE_FAILED, ...cols);
}

// ─── INBOX_PEEK_RACE_SKIP ─────────────────────────────────────────────────────
export function emitInboxPeekRaceSkip(
  audit: MessagingAuditSink,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_PEEK_RACE_SKIP, `file=${opts.file}`);
}

// ─── INBOX_META_FAILED ────────────────────────────────────────────────────────
export function emitInboxMetaFailed(
  audit: MessagingAuditSink,
  opts: { file: string; kind: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_META_FAILED, `file=${opts.file}`, `kind=${opts.kind}`);
}

// ─── INBOX_RECONCILE ──────────────────────────────────────────────────────────
export function emitInboxReconcile(
  audit: MessagingAuditSink,
  opts: { revertedCount: number; from: string; to: string; reason: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_RECONCILE,
    `reverted_count=${opts.revertedCount}`,
    `from=${opts.from}`,
    `to=${opts.to}`,
    `reason=${opts.reason}`,
  );
}

// ─── INBOX_NACK ───────────────────────────────────────────────────────────────
export function emitInboxNack(
  audit: MessagingAuditSink,
  opts: { file: string; reason?: string },
): void {
  const cols: string[] = [`file=${opts.file}`];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_NACK, ...cols);
}

// ─── INBOX_RESTORE_CONFLICT (phase 1020) ──────────────────────────────────────
export function emitInboxRestoreConflict(
  audit: MessagingAuditSink,
  opts: { file: string; op: string; stageName: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT,
    `file=${opts.file}`,
    `op=${opts.op}`,
    `stage_name=${opts.stageName}`,
  );
}

// ─── INBOX_STAGE_QUARANTINE (phase 1034) ──────────────────────────────────────
export function emitInboxStageQuarantine(
  audit: MessagingAuditSink,
  opts: { file: string; reason: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_STAGE_QUARANTINE,
    `file=${opts.file}`,
    `reason=${opts.reason}`,
  );
}

// ─── OUTBOX_SENT ──────────────────────────────────────────────────────────────
export function emitOutboxSent(
  audit: MessagingAuditSink,
  opts: {
    from: string;
    to: string;
    type: string;
    id: string;
  },
): void {
  const cols: string[] = [
    `from=${opts.from}`,
    `to=${opts.to}`,
    `type=${opts.type}`,
    `id=${opts.id}`,
  ];
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_SENT, ...cols);
}

// ─── OUTBOX_LIST_FAILED ───────────────────────────────────────────────────────
export function emitOutboxListFailed(
  audit: MessagingAuditSink,
  opts: { dir: string; op?: string; reason: string },
): void {
  const cols: string[] = [`dir=${opts.dir}`];
  if (opts.op !== undefined) cols.push(`op=${opts.op}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_LIST_FAILED, ...cols);
}

// ─── OUTBOX_PEEK_FAILED ───────────────────────────────────────────────────────
export function emitOutboxPeekFailed(
  audit: MessagingAuditSink,
  opts: { file: string; stage: 'list' | 'read' | 'decode'; reason: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.OUTBOX_PEEK_FAILED,
    `file=${opts.file}`,
    `stage=${opts.stage}`,
    `reason=${opts.reason}`,
  );
}

// ─── OUTBOX_PROCESSING_ORPHAN_CLEANED ─────────────────────────────────────────
export function emitOutboxProcessingOrphanCleaned(
  audit: MessagingAuditSink,
  opts: { count: number },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_PROCESSING_ORPHAN_CLEANED, `count=${opts.count}`);
}

// ─── OUTBOX_CLAIM_FAILED ──────────────────────────────────────────────────────
export function emitOutboxClaimFailed(
  audit: MessagingAuditSink,
  opts: { file: string; op: string; reason: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.OUTBOX_CLAIM_FAILED,
    `file=${opts.file}`,
    `op=${opts.op}`,
    `reason=${opts.reason}`,
  );
}

// ─── UNKNOWN_DESTINATION_DLQ ──────────────────────────────────────────────────
export function emitUnknownDestinationDlq(
  audit: MessagingAuditSink,
  opts: { targetClawId: string; reason: string; file: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_DLQ,
    `target_claw_id=${opts.targetClawId}`,
    `reason=${opts.reason}`,
    `file=${opts.file}`,
  );
}

// ─── UNKNOWN_DESTINATION_REJECTED (phase 1170) ─────────────────────────────────
export function emitUnknownDestinationRejected(
  audit: MessagingAuditSink,
  opts: { targetClawId: string; reason: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_REJECTED,
    `target_claw_id=${opts.targetClawId}`,
    `reason=${opts.reason}`,
    'fallback=unavailable',
  );
}

// ─── OUTBOX_SEND_FAILED ───────────────────────────────────────────────────────
export function emitOutboxSendFailed(
  audit: MessagingAuditSink,
  opts: {
    from: string;
    to: string;
    type: string;
    id: string;
    reason: string;
  },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED,
    `from=${opts.from}`,
    `to=${opts.to}`,
    `type=${opts.type}`,
    `id=${opts.id}`,
    `reason=${opts.reason}`,
  );
}

// ─── OUTBOX_BODY_OVERSIZE ─────────────────────────────────────────────────────
// phase 430 Step E (review medium、inbox cap 对称): outbox body 超 cap、emit + caller 收 throw
// phase 935: wire size limit covers the encoded payload (body + metadata)
export function emitOutboxBodyOversize(
  audit: MessagingAuditSink,
  opts: {
    clawId: string;
    to: string;
    id: string;
    type: string;
    bodySize: number;
    wireSize: number;
    cap: number;
  },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.OUTBOX_BODY_OVERSIZE,
    `from=${opts.clawId}`,
    `to=${opts.to}`,
    `id=${opts.id}`,
    `type=${opts.type}`,
    `body_size=${opts.bodySize}`,
    `wire_size=${opts.wireSize}`,
    `cap=${opts.cap}`,
  );
}
