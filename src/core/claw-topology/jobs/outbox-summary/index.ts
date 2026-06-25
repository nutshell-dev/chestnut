/**
 * @module L4.ClawTopology.OutboxSummary
 *
 * 业务：每 cron tick 扫所有 claws/{*}/outbox/pending → 若 unread > 0 + 新版本 → 写
 * dedup 后的 summary 到 motion/inbox/pending. Cross-claw hub-and-spoke aggregator
 * (motion 作为 hub 聚合 claws spoke outbox 状态)、归 ClawTopology business 衍生。
 *
 * phase 1476 立模、phase 42 走 Messaging 入口。
 * phase 134 demote 到 cron job helper、phase 697 revert：核心业务是 cross-claw 聚合
 * 而非 cron 的子能力、归 ClawTopology jobs/ sister 内 (M#1 + M#3、与 ClawTopology
 * hub-spoke business 同根)。
 *
 * Design: design/architecture.md §27b ClawTopology + design/modules/l2a_cron.md (Cron protocol)
 */

import type { AuditLog } from '../../../../foundation/audit/index.js';
import { formatErr } from '../../../../foundation/node-utils/index.js';
import type { FileSystem } from '../../../../foundation/fs/index.js';
import type { InboxReader, InboxWriter, OutboxReader } from '../../../../foundation/messaging/index.js';
import type { ClawTopology } from '../../index.js';
import { OUTBOX_SUMMARY_AUDIT_EVENTS } from './audit-events.js';
import { runOutboxSummaryTick } from './tick.js';
import type { CronJob } from '../../../../foundation/cron/runner.js';
import { parseSchedule } from '../../../../foundation/cron/runner.js';
import type { CronJobGlobalConfig } from '../../../../foundation/cron/runner.js';

/** Cron job timeout per M#2 (per-module business decides). 5s 充裕：dedup scan = meta parse only. */
export const OUTBOX_SUMMARY_CRON_TIMEOUT_MS = 5_000;


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
  globalConfig: CronJobGlobalConfig<'outbox_summary'>,
): CronJob {
  return {
    name: 'outbox-summary',
    enabled: globalConfig.cron.jobs.outbox_summary.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.outbox_summary.schedule, deps.audit),
    handler: (signal) => runOutboxSummary({ ...deps, signal }),
    timeoutMs: OUTBOX_SUMMARY_CRON_TIMEOUT_MS,
  };
}
