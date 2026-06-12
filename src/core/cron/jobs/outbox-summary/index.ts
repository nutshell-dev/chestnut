/**
 * @module L5.Cron.Jobs.OutboxSummary
 * phase 134: demote 到 cron job helper（从 core/outbox-summary/ 物理迁、
 * phase 1476 立模、phase 42 走 Messaging 入口）.
 *
 * 业务：每 cron tick 扫所有 claws/{*}/outbox/pending → 若 unread > 0 + 新版本 → 写
 * dedup 后的 summary 到 motion/inbox/pending.
 *
 * Design：design/modules/l5_cron.md §5 + §1.3 outbox-summary row + §1.A phase 134 reframing log.
 */

import type { AuditLog } from '../../../../foundation/audit/index.js';
import { formatErr } from '../../../../foundation/utils/index.js';
import type { FileSystem } from '../../../../foundation/fs/types.js';
import type { InboxReader, InboxWriter, OutboxReader } from '../../../../foundation/messaging/index.js';
import type { ClawTopology } from '../../../../core/claw-topology/index.js';
import { OUTBOX_SUMMARY_AUDIT_EVENTS } from './audit-events.js';
import { runOutboxSummaryTick } from './tick.js';
import type { CronJob } from '../../runner.js';
import { parseSchedule } from '../../runner.js';
import type { ClawGlobalConfig } from '../../../../foundation/config/index.js';

/** Cron job timeout per M#2 (per-module business decides). 5s 充裕：dedup scan = meta parse only. */
export const OUTBOX_SUMMARY_CRON_TIMEOUT_MS = 5_000;

// business re-export
export { runOutboxSummaryTick } from './tick.js';

export type { OutboxSummaryState } from './types.js';
export { toExtraMeta } from './types.js';
export { computeHash, HASH_LEN } from './hash.js';
export { scanOutboxes } from './scan.js';
export { findExistingSummaryByHash, DEDUP_DONE_WINDOW_MS, SUMMARY_HASH_META_KEY } from './dedup.js';
export { writeNewSummary, SUMMARY_INBOX_TYPE } from './write.js';
export { OUTBOX_SUMMARY_AUDIT_EVENTS };

// cron wrapper
export interface OutboxSummaryJobOptions {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  fs: FileSystem;
  audit: AuditLog;
  inboxReader: InboxReader;
  inboxWriter: InboxWriter;
  outboxReader: OutboxReader;
  signal?: AbortSignal;
}

export interface OutboxSummaryJobDeps {
  clawTopology: ClawTopology;
  fs: FileSystem;
  audit: AuditLog;
  inboxReader: InboxReader;
  inboxWriter: InboxWriter;
  outboxReader: OutboxReader;
}

export async function runOutboxSummary(opts: OutboxSummaryJobOptions): Promise<void> {
  try {
    await runOutboxSummaryTick({
      clawTopology: opts.clawTopology,
      fs: opts.fs,
      audit: opts.audit,
      inboxReader: opts.inboxReader,
      inboxWriter: opts.inboxWriter,
      outboxReader: opts.outboxReader,
    });
  } catch (err) {
    opts.audit.write(
      OUTBOX_SUMMARY_AUDIT_EVENTS.OUTBOX_SUMMARY_FAILED,
      `reason=${formatErr(err)}`,
    );
    throw err;
  }
}

export function createOutboxSummaryJob(
  deps: OutboxSummaryJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'outbox-summary',
    enabled: globalConfig.cron.jobs.outbox_summary.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.outbox_summary.schedule, deps.audit),
    handler: (signal) => runOutboxSummary({ ...deps, signal }),
    timeoutMs: OUTBOX_SUMMARY_CRON_TIMEOUT_MS,
  };
}
