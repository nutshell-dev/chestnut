/**
 * @module L2.Messaging.AuditEmit
 * Typed audit emit functions for messaging module (phase 1163 r128 E fork β-2).
 *
 * Per-event typed payload enforces phase 706 audit key naming decision tree
 * (camelCase typed col + business ID typed). Mirror phase 1127 snapshot/audit-emit.ts
 * + phase 1130 async-task-system + phase 1141 contract per-module typed emit cascade
 * (4th module typed emit cascade N+1 实证累).
 *
 * Scope (per dispatch E fork β-2)：outbox-writer 2 callsite only.
 * inbox-writer + inbox-reader 10 raw audit.write site 推 follow-up phase if cluster.
 */

import type { AuditLog } from '../audit/index.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';

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

// ─── OUTBOX_SEND_FAILED ───────────────────────────────────────────────────────
export function emitOutboxSendFailed(
  audit: AuditLog,
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
