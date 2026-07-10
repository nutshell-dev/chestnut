/**
 * @module L6.CLI.Claw.Ps
 *
 * Phase 841: `chestnut claw <name> ps` — list background migrated exec tasks.
 * Phase 842: distinguish corrupted/IO errors from "no tasks" and report them explicitly.
 * Phase 842 Step B: validate ToolTask shape with Zod instead of bare `as` assertions.
 * Phase 843: delegate task listing to AsyncTaskSystem.listMigratedExecTasks().
 */

import { getClawDir } from '../../core/claw-topology/index.js';
import type {
  MigratedExecTaskInfo,
  TaskReadError,
} from '../../core/async-task-system/index.js';

export async function psCommand(
  deps: {
    listMigratedExecTasks: (clawDir: string) => { tasks: MigratedExecTaskInfo[]; errors: TaskReadError[] };
  },
  name: string,
  _args: string[],
): Promise<void> {
  const clawDir = getClawDir(name);
  const { tasks, errors } = deps.listMigratedExecTasks(clawDir);

  if (tasks.length === 0 && errors.length === 0) {
    console.log('No background exec tasks running.');
    return;
  }

  if (tasks.length > 0) {
    console.log(`\nBackground exec (${tasks.length} running):\n`);
    for (const t of tasks) {
      const elapsed = fmtDuration(Date.now() - new Date(t.createdAt).getTime());
      const shortCmd = t.command.length > 60 ? t.command.slice(0, 57) + '...' : t.command;
      const liveness = t.lastOutputMs !== null
        ? `last output ${fmtDuration(t.lastOutputMs)} ago`
        : 'no output yet';
      console.log(`  Task ${t.taskId}  ${elapsed}  ${liveness}  ${shortCmd}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} task file(s) could not be read:`);
    for (const err of errors) {
      console.error(`  ${err.taskId}: ${err.reason}`);
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
