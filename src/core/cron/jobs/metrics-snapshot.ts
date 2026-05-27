import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { type ClawDir } from '../../../foundation/identity/index.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const METRICS_SNAPSHOT_CRON_TIMEOUT_MS = 30_000;

export interface MetricsSnapshotOptions {
  motionDir: ClawDir;   // motion 目录完整路径
  fs: FileSystem;       // baseDir 可访问 motionDir（用于 clawforumFs）
  audit: AuditLog;
  signal?: AbortSignal;
}

/** 统计目录下文件数，目录不存在返回 0 */
function countDir(dir: string, fs: FileSystem): number {
  try {
    return fs.listSync(dir).length;
  } catch {
    return 0; // partial scan / best-effort
  }
}

export async function runMetricsSnapshot(opts: MetricsSnapshotOptions): Promise<void> {
  const { motionDir, fs, audit } = opts;

  const inboxPending  = countDir(`${motionDir}/inbox/pending`, fs);
  const inboxDone     = countDir(`${motionDir}/inbox/done`, fs);
  const inboxFailed   = countDir(`${motionDir}/inbox/failed`, fs);
  const outboxPending = countDir(`${motionDir}/outbox/pending`, fs);
  const outboxDone    = countDir(`${motionDir}/outbox/done`, fs);
  const outboxFailed  = countDir(`${motionDir}/outbox/failed`, fs);
  const tasksPending  = countDir(`${motionDir}/tasks/pending`, fs);
  const tasksQueuePending = countDir(`${motionDir}/tasks/queues/pending`, fs);
  const tasksRunning  = countDir(`${motionDir}/tasks/running`, fs);

  audit.write(
    CRON_AUDIT_EVENTS.METRICS_SNAPSHOT,
    `inbox_pending=${inboxPending}`,
    `inbox_done=${inboxDone}`,
    `inbox_failed=${inboxFailed}`,
    `outbox_pending=${outboxPending}`,
    `outbox_done=${outboxDone}`,
    `outbox_failed=${outboxFailed}`,
    `tasks_pending=${tasksPending}`,
    `tasks_queue_pending=${tasksQueuePending}`,
    `tasks_running=${tasksRunning}`,
  );
}
