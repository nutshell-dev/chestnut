/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 1476: one orchestration tick = scan + dedup + write.
 * phase 42: 全部 I/O 改走 Messaging 对外入口；删自管 archive。
 * phase 938: signal propagated and checked at scan/dedup/write boundaries.
 *
 * 流程：
 * 1. scan claws/*\/outbox/pending（经 OutboxReader）→ state
 * 2. if total_msgs == 0: return（状态未变，不产生 audit）
 * 3. dedup query（经 InboxReader.findByExtraMeta）hash 已在 pending/inflight/done (mtime<24h 仅 done) → return（状态未变）
 * 4. 不同 hash → 写新 summary（经 InboxWriter）
 *
 * 异常隔离归 cron runner（throw → cron_job_error / 详 l5_cron.md §1）.
 */

import type { FileSystem } from '../../../../foundation/fs/index.js';
import type { AuditLog } from '../../../../foundation/audit/index.js';
import type { InboxReader, InboxWriter, OutboxReader } from '../../../../foundation/messaging/index.js';
import type { ClawTopology } from '../../index.js';
import { scanOutboxes } from './scan.js';
import { findExistingSummaryByHash } from './dedup.js';
import { writeNewSummary } from './write.js';

interface OutboxSummaryTickDeps {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  fs: FileSystem;
  inboxReader: InboxReader;
  inboxWriter: InboxWriter;
  outboxReader: OutboxReader;
  audit: AuditLog;
  now?: () => number;
  /** phase 938: cooperative abort signal checked at stage boundaries. */
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('Outbox summary tick aborted');
  }
}

export async function runOutboxSummaryTick(deps: OutboxSummaryTickDeps): Promise<void> {
  const state = await scanOutboxes({
    clawTopology: deps.clawTopology,
    fs: deps.fs,
    outboxReader: deps.outboxReader,
    signal: deps.signal,
  });

  if (state.total_msgs === 0) {
    return;
  }

  const hit = await findExistingSummaryByHash(
    { inboxReader: deps.inboxReader },
    state.hash,
  );
  if (hit !== null) {
    return;
  }

  // phase 938: after dedup and before writing inbox, respect cancellation.
  throwIfAborted(deps.signal);

  await writeNewSummary(
    { inboxWriter: deps.inboxWriter, audit: deps.audit, now: deps.now },
    state,
  );
}
