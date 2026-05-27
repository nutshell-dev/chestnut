/**
 * @module L5.Cron.Jobs.OutboxDrain
 * Cron tick trigger for outbox drain.
 *
 * phase 1333: delegates cross-claw delivery to Messaging.drainOutboxes().
 * Cron no longer accesses claws/*, inbox, or file-move protocols directly.
 */

import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import type { Messaging } from '../../../foundation/messaging/index.js';
export { DEFAULT_LIMIT_PER_CLAW } from '../../../foundation/messaging/drain-outboxes.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const OUTBOX_DRAIN_CRON_TIMEOUT_MS = 30_000;

export interface OutboxDrainOptions {
  messaging: Messaging;
  limitPerClaw?: number;
  signal?: AbortSignal;
  audit: AuditLog;
}

export async function runOutboxDrain(opts: OutboxDrainOptions): Promise<void> {
  const startMs = Date.now();
  try {
    const result = await opts.messaging.drainOutboxes({
      limitPerClaw: opts.limitPerClaw,
      signal: opts.signal,
    });
    opts.audit.write(
      CRON_AUDIT_EVENTS.OUTBOX_DRAIN_DONE,
      `total=${result.delivered}`,
      `failed=${result.failed}`,
      `duration_ms=${Date.now() - startMs}`,
    );
  } catch (err) {
    opts.audit.write(
      CRON_AUDIT_EVENTS.OUTBOX_DRAIN_FAILED,
      `reason=drain_threw`,
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
