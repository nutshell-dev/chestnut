/**
 * async-task pending↔running cross-source 一致性 audit。
 *
 * 应然 anchor（per design/modules/l4_async_task_system.md §「persist-state observability」、phase 239 + phase 284）：
 * - 内存 view 已改为 derive from fs；QC-1/QC-2/QC-3（内存集合 vs 磁盘集合）因此移除。
 * - QC-4 保留：cancellingIds 是内部 transient 内存 set，仍需是 active task（pending ∪ running）的子集。
 *
 * 不 throw（DP1 + Path #4 防 break dispatch / ingest 主路径）。
 * fs list 失败 → emit _skipped。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/utils/index.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR } from './dirs.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';

export interface QueueSnapshot {
  readonly cancellingIds: ReadonlySet<string>;
}

export async function auditQueueCrossSource(
  snapshot: QueueSnapshot,
  fs: FileSystem,
  audit: AuditLog,
  traceTag: string,
): Promise<void> {
  let pendingDiskIds: Set<string>;
  let runningDiskIds: Set<string>;
  try {
    pendingDiskIds = await listTaskIdsInDir(fs, TASKS_QUEUES_PENDING_DIR);
    runningDiskIds = await listTaskIdsInDir(fs, TASKS_QUEUES_RUNNING_DIR);
  } catch (err) {
    audit.write(
      TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_SKIPPED,
      `reason=fs_list_failed`,
      `error=${formatErr(err)}`,
      `trace=${traceTag}`,
    );
    return;
  }

  checkQC4_CancellingSubsetOfActive(snapshot, pendingDiskIds, runningDiskIds, audit, traceTag);
}

async function listTaskIdsInDir(fs: FileSystem, dir: string): Promise<Set<string>> {
  const exists = await fs.exists(dir);
  if (!exists) return new Set();
  const entries = await fs.list(dir, { includeDirs: false });
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.name.endsWith('.json')) ids.add(e.name.slice(0, -5));
  }
  return ids;
}

function checkQC4_CancellingSubsetOfActive(
  s: QueueSnapshot,
  pendingDiskIds: Set<string>,
  runningDiskIds: Set<string>,
  audit: AuditLog,
  trace: string,
): void {
  const active = new Set([...pendingDiskIds, ...runningDiskIds]);
  const orphan = [...s.cancellingIds].filter(id => !active.has(id));
  if (orphan.length === 0) return;
  audit.write(
    TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_MISMATCH,
    `kind=qc4_cancelling_orphan`,
    `orphan_ids=${orphan.slice(0, 5).join(',')}`,
    `orphan_count=${orphan.length}`,
    `trace=${trace}`,
  );
}
