/**
 * @module L6.CLI.Claw.Ps
 *
 * Phase 841: `chestnut claw <name> ps` — list background migrated exec tasks.
 * Phase 842: distinguish corrupted/IO errors from "no tasks" and report them explicitly.
 * Phase 842 Step B: validate ToolTask shape with Zod instead of bare `as` assertions.
 */

import * as path from 'path';
import { CliError } from '../errors.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import {
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from '../../core/async-task-system/dirs.js';
import { ToolTaskSchema } from '../../core/async-task-system/task-schemas.js';
import { clawExists } from '../../assembly/config/config-load.js';
import type { FileSystem } from '../../foundation/fs/index.js';

interface MigratedExec {
  taskId: string;
  command: string;
  createdAt: string;
  lastOutputMs: number | null;
}

interface TaskReadError {
  fileName: string;
  reason: string;
}

export async function psCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
  _args: string[],
): Promise<void> {
  const configPath = getClawConfigPath(name);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${name}" does not exist`);
  }

  const clawDir = getClawDir(name);
  const runningDir = path.join(clawDir, TASKS_QUEUES_RUNNING_DIR);
  const runningFs = deps.fsFactory(runningDir);
  if (!runningFs.existsSync('.')) {
    console.log('No background exec tasks running.');
    return;
  }

  const entries = runningFs.listSync('.', { includeDirs: false });
  const migrated: MigratedExec[] = [];
  const errors: TaskReadError[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const raw = runningFs.readSync(entry.name);
      const parsed = ToolTaskSchema.passthrough().safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(`schema mismatch: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      }
      const task = parsed.data;
      if (task.kind !== 'tool' || (task as Record<string, unknown>).mode !== 'migrated') continue;

      const taskId = task.id;
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
        if (errno === 'ENOENT') {
          // result.txt not created yet — process still in first soft-timeout window
        } else {
          errors.push({ fileName: `Task ${taskId} result.txt`, reason: `${errno ?? 'UNKNOWN'}: ${String(e)}` });
        }
      }

      migrated.push({ taskId, command, createdAt, lastOutputMs });
    } catch (e: unknown) {
      // corrupted running task file, report instead of silently skipping
      errors.push({ fileName: entry.name, reason: String(e) });
    }
  }

  if (migrated.length === 0 && errors.length === 0) {
    console.log('No background exec tasks running.');
    return;
  }

  if (migrated.length > 0) {
    console.log(`\nBackground exec (${migrated.length} running):\n`);
    for (const m of migrated) {
      const elapsed = fmtDuration(Date.now() - new Date(m.createdAt).getTime());
      const shortCmd = m.command.length > 60 ? m.command.slice(0, 57) + '...' : m.command;
      const liveness = m.lastOutputMs !== null
        ? `last output ${fmtDuration(m.lastOutputMs)} ago`
        : 'no output yet';
      console.log(`  Task ${m.taskId}  ${elapsed}  ${liveness}  ${shortCmd}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} task file(s) could not be read:`);
    for (const err of errors) {
      console.error(`  ${err.fileName}: ${err.reason}`);
    }
  }
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
