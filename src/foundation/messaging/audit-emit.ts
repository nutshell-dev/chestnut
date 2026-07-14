/**
 * @module L2c.Messaging.AuditEmit
 * Typed audit emit functions for messaging module (phase 1163 r128 E fork β-2,
 * phase 1210 cascade closure inbox-writer/reader).
 *
 * Per-event typed payload enforces phase 706 audit key naming decision tree
 * (camelCase typed col + business ID typed). Mirror phase 1127 snapshot/audit-emit.ts
 * + phase 1130 async-task-system + phase 1141 contract per-module typed emit cascade.
 */

import type { AuditLog } from '../audit/index.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import type { ClawId } from '../claw-identity/index.js';




// ─── INBOX_WRITTEN ────────────────────────────────────────────────────────────
// phase 437 Step A (phase 434 cluster follow-up): contract_id forensic join
export function emitInboxWritten(
  audit: AuditLog,
  opts: { file: string; to?: string; contractId?: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN,
    `file=${opts.file}`,
    `to=${opts.to ?? 'broadcast'}`,
    `contract_id=${opts.contractId ?? ''}`,
  );
}

// ─── INBOX_WRITE_FAILED ───────────────────────────────────────────────────────
// phase 437 Step A (phase 434 cluster follow-up): contract_id forensic join
export function emitInboxWriteFailed(
  audit: AuditLog,
  opts: { file: string; to?: string; reason: string; contractId?: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_WRITE_FAILED,
    `file=${opts.file}`,
    `to=${opts.to ?? 'broadcast'}`,
    `reason=${opts.reason}`,
    `contract_id=${opts.contractId ?? ''}`,
  );
}

// ─── INBOX_BODY_OVERSIZE ──────────────────────────────────────────────────────
// phase 429 Step A (review medium): inbox body 超 cap、emit + caller 收 throw
// phase 434 Step C (review N11 partial、outbox 对称): contract_id forensic join
// phase 933: wire size limit covers the encoded payload (body + metadata + extraFields)
export function emitInboxBodyOversize(
  audit: AuditLog,
  opts: {
    source: string;
    to?: string;
    type: string;
    bodySize: number;
    wireSize: number;
    cap: number;
    contractId?: string;
  },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_BODY_OVERSIZE,
    `source=${opts.source}`,
    `to=${opts.to ?? 'broadcast'}`,
    `type=${opts.type}`,
    `body_size=${opts.bodySize}`,
    `wire_size=${opts.wireSize}`,
    `cap=${opts.cap}`,
    `contract_id=${opts.contractId ?? ''}`,
  );
}

// ─── INBOX_LIST_FAILED ────────────────────────────────────────────────────────
export function emitInboxListFailed(
  audit: AuditLog,
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
  audit: AuditLog,
  opts: { file: string; errorCode?: string; reason: string },
): void {
  const cols: string[] = [`file=${opts.file}`];
  if (opts.errorCode !== undefined) cols.push(`error_code=${opts.errorCode}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_FAILED, ...cols);
}

// ─── INBOX_PRIORITY_UNKNOWN ───────────────────────────────────────────────────
export function emitInboxPriorityUnknown(
  audit: AuditLog,
  opts: { file: string; original: string; fallback: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_PRIORITY_UNKNOWN, `file=${opts.file}`, `original=${opts.original}`, `fallback=${opts.fallback}`);
}

// ─── INBOX_LEGACY_CLAW_ID_FIELD ───────────────────────────────────────────────
export function emitInboxLegacyClawIdField(
  audit: AuditLog,
  opts: { file: string; clawId: ClawId },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_LEGACY_CLAW_ID_FIELD, `file=${opts.file}`, `claw_id=${opts.clawId}`);
}

// ─── INBOX_DEDUPED ────────────────────────────────────────────────────────────
// phase 437 Step B (phase 434 cluster follow-up): contract_id forensic join
// phase 849: dual-key task IDs — emit both short and full ID when available
export function emitInboxDeduped(
  audit: AuditLog,
  opts: { file: string; shortTaskId?: string; fullTaskId?: string; contractId?: string },
): void {
  const cols: string[] = [`file=${opts.file}`];
  // phase 849: dual-key IDs; keep legacy taskId= column for backward compatibility
  const legacyTaskId = opts.shortTaskId ?? opts.fullTaskId;
  if (legacyTaskId !== undefined) cols.push(`taskId=${legacyTaskId}`);
  if (opts.shortTaskId !== undefined) cols.push(`shortTaskId=${opts.shortTaskId}`);
  if (opts.fullTaskId !== undefined) cols.push(`fullTaskId=${opts.fullTaskId}`);
  cols.push(`contract_id=${opts.contractId ?? ''}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED, ...cols);
}

// ─── INBOX_MARK_DONE_FAILED ───────────────────────────────────────────────────
// phase 578: 加 file forensic col、forensic 解析能定位是哪个 file mark-done 失败
export function emitInboxMarkDoneFailed(
  audit: AuditLog,
  opts: { file: string; reason: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_MARK_DONE_FAILED, `file=${opts.file}`, `reason=${opts.reason}`);
}

// ─── INBOX_DONE ───────────────────────────────────────────────────────────────
export function emitInboxDone(
  audit: AuditLog,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_DONE, `file=${opts.file}`);
}

// ─── INBOX_MISROUTED (phase 442) ─────────────────────────────────────────────
export function emitInboxMisrouted(
  audit: AuditLog,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_MISROUTED, `file=${opts.file}`);
}

// ─── OUTBOX_DELIVERED ─────────────────────────────────────────────────────────
export function emitOutboxDelivered(
  audit: AuditLog,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_DELIVERED, `file=${opts.file}`);
}

// ─── INBOX_MOVE_FAILED ────────────────────────────────────────────────────────
export function emitInboxMoveFailed(
  audit: AuditLog,
  opts: { file: string; op: string; errorCode?: string; reason: string },
): void {
  const cols: string[] = [`file=${opts.file}`, `op=${opts.op}`];
  if (opts.errorCode !== undefined) cols.push(`error_code=${opts.errorCode}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_MOVE_FAILED, ...cols);
}

// ─── INBOX_PEEK_RACE_SKIP ─────────────────────────────────────────────────────
export function emitInboxPeekRaceSkip(
  audit: AuditLog,
  opts: { file: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_PEEK_RACE_SKIP, `file=${opts.file}`);
}

// ─── INBOX_META_FAILED ────────────────────────────────────────────────────────
export function emitInboxMetaFailed(
  audit: AuditLog,
  opts: { file: string; kind: string },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_META_FAILED, `file=${opts.file}`, `kind=${opts.kind}`);
}

// ─── INBOX_RECONCILE ──────────────────────────────────────────────────────────
export function emitInboxReconcile(
  audit: AuditLog,
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
  audit: AuditLog,
  opts: { file: string; reason?: string },
): void {
  const cols: string[] = [`file=${opts.file}`];
  if (opts.reason !== undefined) cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.INBOX_NACK, ...cols);
}

// ─── INBOX_RESTORE_CONFLICT (phase 1020) ──────────────────────────────────────
export function emitInboxRestoreConflict(
  audit: AuditLog,
  opts: { file: string; op: string; stageName: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT,
    `file=${opts.file}`,
    `op=${opts.op}`,
    `stage_name=${opts.stageName}`,
  );
}

// ─── OUTBOX_SENT ──────────────────────────────────────────────────────────────
export function emitOutboxSent(
  audit: AuditLog,
  opts: {
    from: string;
    to: string;
    type: string;
    id: string;
    contractId?: string;
  },
): void {
  const cols: string[] = [
    `from=${opts.from}`,
    `to=${opts.to}`,
    `type=${opts.type}`,
    `id=${opts.id}`,
  ];
  if (opts.contractId !== undefined) cols.push(`contractId=${opts.contractId}`);
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_SENT, ...cols);
}

// ─── OUTBOX_LIST_FAILED ───────────────────────────────────────────────────────
export function emitOutboxListFailed(
  audit: AuditLog,
  opts: { dir: string; op?: string; reason: string },
): void {
  const cols: string[] = [`dir=${opts.dir}`];
  if (opts.op !== undefined) cols.push(`op=${opts.op}`);
  cols.push(`reason=${opts.reason}`);
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_LIST_FAILED, ...cols);
}

// ─── OUTBOX_PEEK_FAILED ───────────────────────────────────────────────────────
export function emitOutboxPeekFailed(
  audit: AuditLog,
  opts: { file: string; stage: 'read' | 'decode'; reason: string },
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
  audit: AuditLog,
  opts: { count: number },
): void {
  audit.write(MESSAGING_AUDIT_EVENTS.OUTBOX_PROCESSING_ORPHAN_CLEANED, `count=${opts.count}`);
}

// ─── OUTBOX_CLAIM_FAILED ──────────────────────────────────────────────────────
export function emitOutboxClaimFailed(
  audit: AuditLog,
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
  audit: AuditLog,
  opts: { targetClawId: string; reason: string; file: string },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.UNKNOWN_DESTINATION_DLQ,
    `target_claw_id=${opts.targetClawId}`,
    `reason=${opts.reason}`,
    `file=${opts.file}`,
  );
}

// ─── OUTBOX_SEND_FAILED ───────────────────────────────────────────────────────
export function emitOutboxSendFailed(
  audit: AuditLog,
  opts: {
    from: string;
    to: string;
    type: string;
    id: string;
    reason: string;
    // phase 434 Step B (review N11 partial、emitOutboxSent 对称): contract_id forensic join
    contractId?: string;
  },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.OUTBOX_SEND_FAILED,
    `from=${opts.from}`,
    `to=${opts.to}`,
    `type=${opts.type}`,
    `id=${opts.id}`,
    `reason=${opts.reason}`,
    `contract_id=${opts.contractId ?? ''}`,
  );
}

// ─── OUTBOX_BODY_OVERSIZE ─────────────────────────────────────────────────────
// phase 430 Step E (review medium、inbox cap 对称): outbox body 超 cap、emit + caller 收 throw
// phase 935: wire size limit covers the encoded payload (body + metadata)
export function emitOutboxBodyOversize(
  audit: AuditLog,
  opts: {
    clawId: string;
    to: string;
    type: string;
    bodySize: number;
    wireSize: number;
    cap: number;
    // phase 434 Step B (review N11 partial、emitOutboxSent 对称): contract_id 同型
    contractId?: string;
  },
): void {
  audit.write(
    MESSAGING_AUDIT_EVENTS.OUTBOX_BODY_OVERSIZE,
    `from=${opts.clawId}`,
    `to=${opts.to}`,
    `type=${opts.type}`,
    `body_size=${opts.bodySize}`,
    `wire_size=${opts.wireSize}`,
    `cap=${opts.cap}`,
    `contract_id=${opts.contractId ?? ''}`,
  );
}
