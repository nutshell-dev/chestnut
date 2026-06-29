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
import { getProcessStartTime, ProcessExecError } from '../../foundation/process-exec/index.js';
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
  /** Optional override for the migrated hard timeout (ms). Primarily for tests. */
  migratedHardTimeoutMs?: number;
}

interface AsyncExecWrapperDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  retryBaseDelayMs: number;
  moveTaskToDone: (taskId: TaskId) => Promise<void>;
  moveTaskToFailed: (taskId: TaskId) => Promise<void>;
}

const ASYNC_EXEC_SOFT_TIMEOUT_MS = 10_000;

/** Migrated process hard timeout (ms). Process will be killed after this time. */
const ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
    callerType: ctx.callerLabel as CallerType,
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
  const migratedHardTimeoutMs = params.migratedHardTimeoutMs ?? ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS;
  const { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed } = deps;

  return {
    name: EXEC_TOOL_NAME,
    profiles: ['full'],  // Phase 773: wrapper is only for the main agent; subagents use plain sync exec.
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
          description:
            `When set: pure sync mode — the command runs synchronously and is killed ` +
            `after this many milliseconds if it hasn't completed. ` +
            `When not set (default): sync→async mode — the command runs synchronously ` +
            `for up to 10 seconds, then automatically moves to background async execution ` +
            `and the result is delivered via inbox.`,
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

      // --- pure sync mode: caller set an explicit timeout --------------------
      if (args.timeoutMs !== undefined) {
        try {
          const handle = await execWithHandle(
            {
              command,
              cwd: args.cwd as string | undefined,
              timeoutMs: args.timeoutMs as number | undefined,
              stdin: args.stdin as string | undefined,
            },
            ctx,
          );

          const result = await handle.promise;
          return {
            success: true,
            content: result.output || `(no output)\n[command]: ${command}`,
          };
        } catch (err) {
          if (err instanceof ProcessExecError) {
            const short = command.length > 80
              ? command.slice(0, 80) + '[truncated]'
              : command;
            const outputSuffix = err.output
              ? `\n[output]: ${err.output.slice(0, 2000)}`
              : '';
            return {
              success: false,
              content: `Error: ${err.message}\n[command]: ${short}${outputSuffix}`,
            };
          }
          throw err;
        }
      }

      // --- sync→async mode: no explicit timeout, use soft timeout + migration -
      // Create a proxy AbortController linked to the original signal. Before
      // migration we forward abort events so the spawned process is killed as
      // usual. During migration we detach the listener (and unref the child) so
      // the process survives the original turn's AbortSignal.
      const originalSignal = ctx.signal;
      const proxyController = new AbortController();
      const onOriginalAbort = (): void => proxyController.abort();
      if (originalSignal) {
        if (originalSignal.aborted) {
          proxyController.abort();
        } else {
          originalSignal.addEventListener('abort', onOriginalAbort, { once: true });
        }
      }
      const proxyCtx = { ...ctx, signal: proxyController.signal };

      // 1-3. Start the process, collect partial output, and race completion
      //    against soft timeout / original abort signal. Catch ProcessExecError
      //    here so the ToolResult includes [command] instead of falling through
      //    to ToolExecutor's generic timeout formatting.
      let handle: ExecHandle;
      let partialOutput = '';
      let winner: Awaited<ReturnType<typeof raceHandle>>;
      try {
        handle = await execWithHandle(
          {
            command,
            cwd: args.cwd as string | undefined,
            timeoutMs: args.timeoutMs as number | undefined,
            stdin: args.stdin as string | undefined,
          },
          proxyCtx,
        );

        const collect = (chunk: Buffer): void => {
          partialOutput += chunk.toString();
        };
        handle.child.stdout?.on('data', collect);
        handle.child.stderr?.on('data', collect);

        winner = await raceHandle(handle, timeout, ctx.signal);
      } catch (err) {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        if (err instanceof ProcessExecError) {
          const short = command.length > 80
            ? command.slice(0, 80) + '[truncated]'
            : command;
          return {
            success: false,
            content: `Error: ${err.message}\n[command]: ${short}`,
          };
        }
        throw err;
      }

      // 4. Sync completion: return result directly.
      if (winner.type === 'result') {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        const result = winner.value;
        return {
          success: true,
          content: result.output || `(no output)\n[command]: ${command}`,
        };
      }

      // 5. Abort: kill the child and return an error.
      if (winner.type === 'abort') {
        originalSignal?.removeEventListener('abort', onOriginalAbort);
        handle.child.kill('SIGTERM');
        return {
          success: false,
          content: 'Command aborted by caller',
        };
      }

      // 6. Soft timeout: migrate to background async execution.
      //    Detach from the original signal and unref the child so it can outlive
      //    the caller's turn.
      originalSignal?.removeEventListener('abort', onOriginalAbort);
      handle.child.unref();
      const taskId = makeTaskId(newUuid());
      const task = buildMigratedToolTask(taskId, command, ctx, handle);

      try {
        await persistRunningTask(fs, task);
      } catch (persistErr) {
        // Migration persistence failed: kill the child and report error.
        handle.child.kill('SIGTERM');
        auditWriter.write(
          TASK_AUDIT_EVENTS.HANDLER_FAILED,
          `taskId=${taskId}`,
          `context=async_exec_wrapper_persist_failed`,
          `error=${formatErr(persistErr)}`,
        );
        return { success: false, content: `Failed to persist migrated exec task: ${formatErr(persistErr)}` };
      }

      // Background chain: collect full output, persist it, then ask the async
      // task system to deliver the result. By the time executeToolTask reads
      // result.txt the process has already exited and the file contains the
      // complete output.
      const backgroundMonitor = (async (): Promise<void> => {
        let timedOut = false;
        try {
          const hardTimeout = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`Migrated process timed out after ${migratedHardTimeoutMs}ms`));
            }, migratedHardTimeoutMs);
            timer.unref?.();
          });

          const result = await Promise.race([handle.promise, hardTimeout]);
          const fullOutput = result.output || partialOutput;

          await persistPartialOutput(fs, taskId, fullOutput);

          await executeToolTask(
            task,
            () => Promise.resolve({ success: true, content: '' }),
            new AbortController().signal,
            { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed },
          );
        } catch (monitorErr) {
          // Hard timeout or process exited with an error: kill if we timed out,
          // persist whatever we collected plus an error marker, then still try
          // to deliver the result.
          if (timedOut) {
            handle.child.kill('SIGTERM');
            auditWriter.write(
              TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT,
              `taskId=${taskId}`,
              `pid=${handle.child.pid}`,
            );
          }

          try {
            const errorOutput = partialOutput +
              `\n[Process ${timedOut ? 'timed out' : 'exited with error'}: ${formatErr(monitorErr)}]`;
            await persistPartialOutput(fs, taskId, errorOutput);
          } catch (persistErr) {
            emitHandlerFailed(auditWriter, {
              taskId,
              context: 'async_exec_wrapper_persist_error_output',
              error: formatErr(persistErr),
            });
          }

          try {
            await executeToolTask(
              task,
              () => Promise.resolve({ success: true, content: '' }),
              new AbortController().signal,
              { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed },
            );
          } catch (execErr) {
            emitHandlerFailed(auditWriter, {
              taskId,
              context: 'async_exec_wrapper_monitor',
              error: formatErr(execErr),
            });
          }
        }
      })();

      // Fire-and-forget: do not await the background chain in the caller path.
      backgroundMonitor.catch((err) => {
        emitHandlerFailed(auditWriter, {
          taskId,
          context: 'async_exec_wrapper_background',
          error: formatErr(err),
        });
      });

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
