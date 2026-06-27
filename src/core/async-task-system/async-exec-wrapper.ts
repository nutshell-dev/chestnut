/**
 * @module L4.AsyncTaskSystem.AsyncExecWrapper
 *
 * Phase 770: wraps a low-level exec handle factory into a Tool that auto-migrates
 * long-running commands to background async execution after a soft timeout.
 */

import * as path from 'path';
import type { ExecContext, Tool, ToolResult } from '../../foundation/tools/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ExecHandle } from '../../foundation/process-exec/index.js';
import { getProcessStartTime } from '../../foundation/process-exec/index.js';
import type { ExecWithHandleArgs } from '../../foundation/command-tool/index.js';
import { newUuid } from '../../foundation/node-utils/index.js';
import { EXEC_TOOL_NAME } from '../../foundation/command-tool/index.js';
import type { CallerType } from '../../core/caller-types.js';
import { executeToolTask } from './tool-executor.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_QUEUES_RUNNING_DIR } from './dirs.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { emitHandlerFailed } from './audit-emit.js';
import { formatErr } from './_helpers.js';
import type { ToolTask, TaskId } from './types.js';
import { makeTaskId } from './types.js';

export interface AsyncExecWrapperParams {
  execWithHandle: (args: ExecWithHandleArgs, ctx: ExecContext) => Promise<ExecHandle>;
  softTimeoutMs?: number;
}

interface AsyncExecWrapperDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  retryBaseDelayMs: number;
  moveTaskToDone: (taskId: TaskId) => Promise<void>;
  moveTaskToFailed: (taskId: TaskId) => Promise<void>;
}

const ASYNC_EXEC_SOFT_TIMEOUT_MS = 10_000;

/**
 * Build a synthetic ToolTask for a migrated exec command.
 */
function buildMigratedToolTask(
  taskId: TaskId,
  command: string,
  ctx: ExecContext,
  handle: ExecHandle,
): ToolTask {
  const pid = handle.child.pid ?? -1;
  return {
    kind: 'tool',
    id: taskId,
    toolName: EXEC_TOOL_NAME,
    args: { command },
    parentClawDir: ctx.clawDir,
    parentClawId: ctx.clawId,
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
    callerType: ctx.callerLabel === 'claw' ? undefined : ctx.callerLabel as CallerType,
    toolUseId: ctx.currentToolUseId,
    mode: 'migrated',
    migratedPid: pid,
    migratedStartTime: pid > 0 ? getProcessStartTime(pid) : undefined,
  };
}

/**
 * Persist partial output collected before migration so the migrated monitor can
 * deliver it once the process exits.
 */
async function persistPartialOutput(
  fs: FileSystem,
  taskId: TaskId,
  output: string,
): Promise<void> {
  const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${taskId}`;
  await fs.ensureDir(resultDir);
  await fs.writeAtomic(path.join(resultDir, 'result.txt'), output);
}

/**
 * Persist the running task file so AsyncTaskSystem will recover and monitor it.
 */
async function persistRunningTask(
  fs: FileSystem,
  task: ToolTask,
): Promise<void> {
  await fs.writeAtomic(
    `${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`,
    JSON.stringify(task, null, 2),
  );
}

/**
 * Race a process handle against a soft timeout and an optional abort signal.
 */
async function raceHandle(
  handle: ExecHandle,
  softTimeoutMs: number,
  signal?: AbortSignal,
): Promise<{ type: 'result'; value: Awaited<ExecHandle['promise']> } | { type: 'migrate' } | { type: 'abort' }> {
  const softTimeout = new Promise<'migrate'>((resolve) => {
    const timer = setTimeout(() => resolve('migrate'), softTimeoutMs);
    timer.unref?.();
  });

  const abort = signal
    ? new Promise<'abort'>((resolve) => {
        const handler = (): void => resolve('abort');
        signal.addEventListener('abort', handler, { once: true });
      })
    : new Promise<'abort'>(() => { /* never */ });

  const resultPromise = handle.promise.then(
    (value) => ({ type: 'result' as const, value }),
    (err: unknown) => {
      // If the signal aborted the process, prefer the abort path over surfacing
      // the ProcessExecError to the caller.
      if (signal?.aborted) {
        return { type: 'abort' as const };
      }
      throw err;
    },
  );

  const winner = await Promise.race([
    resultPromise,
    softTimeout.then(() => ({ type: 'migrate' as const })),
    abort.then(() => ({ type: 'abort' as const })),
  ]);

  return winner;
}

/**
 * Factory: create an `exec` Tool that transparently migrates long-running
 * commands to AsyncTaskSystem after a soft timeout.
 */
export function createAsyncExecWrapper(
  params: AsyncExecWrapperParams,
  deps: AsyncExecWrapperDeps,
): Tool {
  const { execWithHandle, softTimeoutMs } = params;
  const timeout = softTimeoutMs ?? ASYNC_EXEC_SOFT_TIMEOUT_MS;
  const { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed } = deps;

  return {
    name: EXEC_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    group: 'llm',
    description: 'Execute a shell command in your clawspace. Runs via `sh -c`, so shell features (pipes, redirects, quotes) work normally. Relative paths resolve against your clawspace. Long-running commands are automatically moved to async execution.',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command string to execute, e.g. "ls -la" or "grep -r foo . | head -20"',
        },
        cwd: {
          type: 'string',
          description: 'Working directory, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. cwd: "../memory"). Default: clawspace.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000)',
        },
        stdin: {
          type: 'string',
          description: 'Content to pipe to the command stdin. Use "cat > file" with this instead of heredoc to avoid shell escaping issues.',
        },
      },
      required: ['command'],
    },
    readonly: false,
    idempotent: false,
    supportsAsync: true,

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const command = args.command as string;

      // 1. Start the process via the low-level handle factory.
      const handle = await execWithHandle(
        {
          command,
          cwd: args.cwd as string | undefined,
          timeoutMs: args.timeoutMs as number | undefined,
          stdin: args.stdin as string | undefined,
        },
        ctx,
      );

      // 2. Collect partial output so the migrated monitor can deliver it.
      let partialOutput = '';
      const collect = (chunk: Buffer): void => {
        partialOutput += chunk.toString();
      };
      handle.child.stdout?.on('data', collect);
      handle.child.stderr?.on('data', collect);

      // 3. Race process completion against soft timeout / abort.
      const winner = await raceHandle(handle, timeout, ctx.signal);

      // 4. Sync completion: return result directly.
      if (winner.type === 'result') {
        const result = winner.value;
        return {
          success: true,
          content: result.output || `(no output)\n[command]: ${command}`,
        };
      }

      // 5. Abort: kill the child and return an error.
      if (winner.type === 'abort') {
        handle.child.kill('SIGTERM');
        return {
          success: false,
          content: 'Command aborted by caller',
        };
      }

      // 6. Soft timeout: migrate to background async execution.
      const taskId = makeTaskId(newUuid());
      const task = buildMigratedToolTask(taskId, command, ctx, handle);

      try {
        await persistPartialOutput(fs, taskId, partialOutput);
        await persistRunningTask(fs, task);
      } catch (persistErr) {
        // Migration persistence failed: kill the child and report error.
        handle.child.kill('SIGTERM');
        const errorMsg = `Failed to persist migrated exec task: ${formatErr(persistErr)}`;
        auditWriter.write(
          TASK_AUDIT_EVENTS.HANDLER_FAILED,
          `taskId=${taskId}`,
          `context=async_exec_wrapper_persist_failed`,
          `error=${errorMsg}`,
        );
        return { success: false, content: errorMsg };
      }

      // Fire-and-forget monitoring. Errors are audit-logged, not thrown to caller.
      const monitorPromise = executeToolTask(
        task,
        () => Promise.resolve({ success: true, content: '' }),
        new AbortController().signal,
        { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed },
      ).catch((monitorErr) => {
        emitHandlerFailed(auditWriter, {
          taskId,
          context: 'async_exec_wrapper_monitor',
          error: formatErr(monitorErr),
        });
      });

      // Unref the monitor promise so it does not keep the process alive.
      monitorPromise.then(() => { /* noop */ }).catch(() => { /* noop */ });

      auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_MIGRATED_REGISTERED,
        `taskId=${taskId}`,
        `pid=${task.migratedPid}`,
        `command=${command}`,
      );

      return {
        success: true,
        content: `Command is taking longer than expected, moved to async execution. Task ID: ${taskId}. Result will be delivered when complete.`,
        metadata: { taskId, async: true, migrated: true },
      };
    },
  };
}
