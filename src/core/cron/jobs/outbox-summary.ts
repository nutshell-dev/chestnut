/**
 * @module L5.Cron.Jobs.OutboxSummary
 * phase 1476: cron tick wrapper for outbox-summary business owner.
 *
 * Pulls in business owner `core/outbox-summary` runOutboxSummaryTick + cron-level
 * try/catch + audit emit OUTBOX_SUMMARY_FAILED on throw (per-job timeout escalation
 * handled by runner via timeoutMs / abort signal).
 *
 * Replaces outbox-drain cron job (phase 1160 立 / phase 1333 retrench / phase 1476 砍).
 */

import type { AuditLog } from '../../../foundation/audit/index.js';
import { formatErr } from "../../../foundation/utils/index.js";
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { ChestnutRoot } from '../../../foundation/identity/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { runOutboxSummaryTick } from '../../outbox-summary/index.js';

/** Cron job timeout per ML#2 (per-module business decides). 5s 充裕：dedup scan = file list only. */
export const OUTBOX_SUMMARY_CRON_TIMEOUT_MS = 5_000;

export interface OutboxSummaryJobOptions {
  chestnutRoot: ChestnutRoot;
  fs: FileSystem;
  audit: AuditLog;
  signal?: AbortSignal;
}

export async function runOutboxSummary(opts: OutboxSummaryJobOptions): Promise<void> {
  try {
    await runOutboxSummaryTick({
      chestnutRoot: opts.chestnutRoot,
      fs: opts.fs,
      audit: opts.audit,
    });
  } catch (err) {
    opts.audit.write(
      CRON_AUDIT_EVENTS.OUTBOX_SUMMARY_FAILED,
      `reason=${formatErr(err)}`,
    );
    throw err;
  }
}
