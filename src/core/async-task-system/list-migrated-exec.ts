import * as path from 'path';
import { TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import { ToolTaskSchema } from './task-schemas.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export interface MigratedExecTaskInfo {
  taskId: string;
  command: string;
  createdAt: string;
  lastOutputMs: number | null;
}

export interface TaskReadError {
  taskId: string;
  reason: string;
}

export interface MigratedExecListResult {
  tasks: MigratedExecTaskInfo[];
  errors: TaskReadError[];
}

/**
 * List migrated exec tasks for a given claw directory.
 *
 * Reads the running queue directory, validates each task file against
 * ToolTaskSchema, filters to kind='tool' + mode='migrated', and checks
 * result.txt mtime for liveness.
 *
 * Does NOT require an AsyncTaskSystem instance — stateless query function.
 */
export function listMigratedExecTasks(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawDir: string,
): MigratedExecListResult {
  const runningDir = path.join(clawDir, TASKS_QUEUES_RUNNING_DIR);
  const runningFs = deps.fsFactory(runningDir);

  if (!runningFs.existsSync('.')) {
    return { tasks: [], errors: [] };
  }

  const entries = runningFs.listSync('.', { includeDirs: false });
  const tasks: MigratedExecTaskInfo[] = [];
  const errors: TaskReadError[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const taskId = entry.name.replace(/\.json$/, '');

    try {
      const raw = runningFs.readSync(entry.name);
      const parsed = ToolTaskSchema.passthrough().safeParse(JSON.parse(raw));
      if (!parsed.success) {
        errors.push({
          taskId,
          reason: `schema mismatch: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        });
        continue;
      }
      const task = parsed.data;
      if (task.kind !== 'tool' || (task as Record<string, unknown>).mode !== 'migrated') continue;

      const command = (task.args as Record<string, unknown>).command as string ?? '(unknown)';
      const createdAt = task.createdAt;

      let lastOutputMs: number | null = null;
      const resultPath = path.join(clawDir, TASKS_QUEUES_RESULTS_DIR, taskId, 'result.txt');
      try {
        const resultFs = deps.fsFactory(path.dirname(resultPath));
        const stat = resultFs.statSync(path.basename(resultPath));
        lastOutputMs = Date.now() - stat.mtime.getTime();
      } catch (e: unknown) {
        const errno = (e as { code?: string }).code;
        if (errno !== 'ENOENT') {
          errors.push({ taskId, reason: `result.txt: ${errno ?? 'UNKNOWN'}: ${String(e)}` });
        }
      }

      tasks.push({ taskId, command, createdAt, lastOutputMs });
    } catch (e: unknown) {
      errors.push({ taskId, reason: String(e) });
    }
  }

  return { tasks, errors };
}
