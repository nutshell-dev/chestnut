/**
 * @module L4.AsyncTaskSystem
 * Task system exports
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { AsyncTaskSystem } from './system.js';
import type { AsyncTaskSystemOptions, SubAgentTask } from './types.js';

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
export * from './audit-emit.js';

import * as path from 'path';
import { TASK_AUDIT_EVENTS } from './audit-events.js';

export async function cleanupTaskRetention(opts: {
  motionDir: string;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { motionDir, fs, audit, maxDays, signal } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  const dirs = ['tasks/done', 'tasks/failed', 'tasks/results'];

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
          audit.write(TASK_AUDIT_EVENTS.CLEANUP_RETENTION_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      audit.write(TASK_AUDIT_EVENTS.CLEANUP_RETENTION_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return totalDeleted;
}


/** SubAgent task scheduling payload (sans id/createdAt, filled by writer) */
export type SubAgentTaskInfo = Omit<SubAgentTask, 'id' | 'createdAt'>;

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
