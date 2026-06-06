/**
 * @module L4.AsyncTaskSystem
 * Task system exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import { formatErr } from "../../foundation/utils/index.js";
import type { AuditLog } from '../../foundation/audit/index.js';
import { AsyncTaskSystem } from './system.js';
import type { AsyncTaskSystemOptions } from './types.js';

export { AsyncTaskSystem } from './system.js';
export type { AsyncTaskSystemOptions, SubAgentTask } from './types.js';

export {
  TASKS_SYNC_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
} from './dirs.js';

export { writePendingToolTaskFile } from './tools/_pending-tool-task-writer.js';
export { classifyTaskError } from './_helpers.js';

// phase 1130: typed audit emit functions
// phase 132 ML#8 ratify: wildcard export * by-design、20 个 emit* 中 18 个目前 cross-module 0-caller、保 wildcard ML#7 模块对外承诺扩张策略优先 ML#8、未来若大量 0-caller cluster 浮出可议改显式 list
export * from './audit-emit.js';

import * as path from 'path';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import {
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from './dirs.js';

/**
 * Delete task files (done/, failed/, results/) older than maxDays.
 * Renamed from cleanupTaskRetention in phase 16 Step D (audit M3).
 * Audit event name task_cleanup_retention_delete_failed is wire-level
 * and intentionally left as-is for historical log compatibility.
 */
export async function cleanupExpiredTaskFiles(opts: {
  motionDir: string;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { motionDir, fs, audit, maxDays, signal } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  // phase 120 Step G: bug fix — 原 inline 'tasks/done'/'tasks/failed'/'tasks/results'
  // 与实然 dir 'tasks/queues/done|failed|results' (per TASKS_QUEUES_*_DIR) 路径错配、
  // 导致 fs.existsSync 返 false 后 continue、cleanup 实际清 0 文件 (latent bug)。
  // const 化 + 路径修正 = ML#3 single source 后业务路径正确、cron retention-cleanup 真清正确 dir。
  const dirs = [TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR, TASKS_QUEUES_RESULTS_DIR];

  for (const relPath of dirs) {
    if (signal?.aborted) break;
    const dir = path.join(motionDir, relPath);
    if (!fs.existsSync(dir)) continue;

    const cutoff = now - maxDays * 24 * 60 * 60 * 1000;
    try {
      for (const entry of fs.listSync(dir)) {
        if (signal?.aborted) break;
        if (entry.isDirectory) continue;
        try {
          const stats = fs.statSync(path.join(dir, entry.name));
          if (stats.mtime.getTime() < cutoff) {
            fs.deleteSync(path.join(dir, entry.name));
            totalDeleted++;
          }
        } catch (err) {
          audit.write(TASK_AUDIT_EVENTS.CLEANUP_RETENTION_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${formatErr(err)}`);
        }
      }
    } catch (err) {
      audit.write(TASK_AUDIT_EVENTS.CLEANUP_RETENTION_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${formatErr(err)}`);
    }
  }

  return totalDeleted;
}



/**
 * AsyncTaskSystem 工厂函数。签名与 constructor 1:1；纯透传不加工。
 *
 * 调用方：Assembly。
 * 不调 initialize / startDispatch——业务动作归 Runtime（见 l4_task_system.md §2 "#2 归属辨析"）。
 */
export function createAsyncTaskSystem(
  clawDir: string,
  fs: FileSystem,
  options: AsyncTaskSystemOptions,
): AsyncTaskSystem {
  return new AsyncTaskSystem(clawDir, fs, options);
}
