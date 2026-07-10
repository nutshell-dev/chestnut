import * as path from 'path';
import { TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import { ToolTaskSchema } from './task-schemas.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ShortIdIndex } from './types.js';
import { deriveShortIdFromTaskId, makeFullTaskId } from './types.js';

export interface MigratedExecTaskInfo {
  taskId: string;
  fullTaskId: string;
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
 *
 * Phase 849: running filenames may be FullTaskIds (36-char UUID) or legacy
 * ShortTaskIds (8-char hex). `taskId` remains the shortId for backward
 * compatibility / display; `fullTaskId` is added for persistence paths.
 */
export function listMigratedExecTasks(
  deps: {
    fsFactory: (baseDir: string) => FileSystem;
    auditWriter?: { write: (event: string, payload: Record<string, unknown>) => void };
    shortIdIndex?: ShortIdIndex;
  },
  clawDir: string,
): MigratedExecListResult {
  const runningDir = path.join(clawDir, TASKS_QUEUES_RUNNING_DIR);
  const runningFs = deps.fsFactory(runningDir);

  const tasks: MigratedExecTaskInfo[] = [];
  const errors: TaskReadError[] = [];

  const pushError = (shortTaskId: string, fullTaskId: string | undefined, reason: string) => {
    deps.auditWriter?.write(TASK_AUDIT_EVENTS.TASK_QUERY_FILE_CORRUPT, {
      taskId: shortTaskId,
      fullTaskId: fullTaskId ?? '',
      clawDir,
      reason,
    });
    errors.push({ taskId: shortTaskId, reason });
  };

  if (!runningFs.existsSync('.')) {
    return { tasks: [], errors: [] };
  }

  let entries: ReturnType<typeof runningFs.listSync>;
  try {
    entries = runningFs.listSync('.', { includeDirs: false });
  } catch (e: unknown) {
    pushError('(directory)', undefined, `Cannot list running queue: ${String(e)}`);
    return { tasks, errors };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const fileNameId = entry.name.replace(/\.json$/, '');

    // Phase 849: dual-key task IDs. Derive short/full from filename.
    let shortTaskId: string;
    let fullTaskId: string;
    if (fileNameId.length === 36) {
      fullTaskId = fileNameId;
      shortTaskId = deriveShortIdFromTaskId(makeFullTaskId(fullTaskId));
    } else {
      shortTaskId = fileNameId;
      const resolved = deps.shortIdIndex?.resolve(fileNameId);
      fullTaskId = resolved ?? '';
    }

    try {
      const raw = runningFs.readSync(entry.name);
      const parsed = ToolTaskSchema.passthrough().safeParse(JSON.parse(raw));
      if (!parsed.success) {
        const reason = `schema mismatch: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        pushError(shortTaskId, fullTaskId || undefined, reason);
        continue;
      }
      const task = parsed.data;

      // phase 844 Step D: verify filename ID matches content task.id
      if (task.id !== fileNameId) {
        pushError(shortTaskId, fullTaskId || undefined, `filename ID "${fileNameId}" does not match task.id "${task.id}"`);
        continue;
      }

      // ToolTaskSchema now validates mode as optional enum; check at runtime
      const taskMode = task.mode;
      if (task.kind !== 'tool' || taskMode !== 'migrated') continue;

      const rawCommand = (task.args as Record<string, unknown>).command;
      if (typeof rawCommand !== 'string') {
        pushError(shortTaskId, fullTaskId || undefined, `args.command must be a string, got ${typeof rawCommand}`);
        continue;
      }
      const command = rawCommand;

      // phase 846 Step B: validate createdAt is a parseable datetime
      const createdAtMs = Date.parse(task.createdAt);
      if (Number.isNaN(createdAtMs)) {
        pushError(shortTaskId, fullTaskId || undefined, `createdAt is not a parseable datetime: "${task.createdAt}"`);
        continue;
      }
      const createdAt = task.createdAt;

      let lastOutputMs: number | null = null;
      // Phase 849: result dirs are keyed by fullTaskId; fall back to shortTaskId for legacy
      const resultDirName = fullTaskId || shortTaskId;
      const resultPath = path.join(clawDir, TASKS_QUEUES_RESULTS_DIR, resultDirName, 'result.txt');
      try {
        const resultFs = deps.fsFactory(path.dirname(resultPath));
        const stat = resultFs.statSync(path.basename(resultPath));
        lastOutputMs = Date.now() - stat.mtime.getTime();
      } catch (e: unknown) {
        const errno = (e as { code?: string }).code;
        if (errno !== 'ENOENT') {
          deps.auditWriter?.write(TASK_AUDIT_EVENTS.TASK_QUERY_RESULT_IO_ERROR, {
            taskId: shortTaskId,
            fullTaskId: fullTaskId || '',
            clawDir,
            errno: errno ?? 'UNKNOWN',
            error: String(e),
          });
          errors.push({ taskId: shortTaskId, reason: `result.txt: ${errno ?? 'UNKNOWN'}: ${String(e)}` });
        }
      }

      tasks.push({ taskId: shortTaskId, fullTaskId, command, createdAt, lastOutputMs });
    } catch (e: unknown) {
      pushError(shortTaskId, fullTaskId || undefined, String(e));
    }
  }

  return { tasks, errors };
}
