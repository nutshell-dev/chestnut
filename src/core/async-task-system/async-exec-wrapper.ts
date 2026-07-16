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
import { processExecErrorToToolResult } from '../../foundation/command-tool/exec.js';
import { executeToolTask } from './tool-executor.js';
import { sendToolResult as defaultSendToolResult, sendFallbackError as defaultSendFallbackError } from './result-delivery.js';
import type { SendToolResult, SendFallbackError, WriteInboxAsync } from './result-delivery-types.js';
import { TASKS_QUEUES_RESULTS_DIR, TASKS_QUEUES_RUNNING_DIR } from './dirs.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { STREAM_TASK_EVENTS } from './stream-events.js';
import { emitHandlerFailed } from './audit-emit.js';
import { formatErr } from './_helpers.js';
import type { ToolTask, TaskId, FullTaskId, ShortTaskId, ShortIdIndex } from './types.js';
import { makeFullTaskId, taskShortId } from './types.js';

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
  parentStreamLog?: { write(entry: Record<string, unknown>): void };
  shortIdIndex: ShortIdIndex;
  sendToolResult?: SendToolResult<ToolTask>;
  sendFallbackError?: SendFallbackError<ToolTask>;
  writeInboxAsync?: WriteInboxAsync;
}

const ASYNC_EXEC_SOFT_TIMEOUT_MS = 10_000;

/** Migrated process hard timeout (ms). Process will be killed after this time. */
export const ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Build a synthetic ToolTask for a migrated exec command.
 */
function buildMigratedToolTask(
  fullId: FullTaskId,
  shortId: ShortTaskId,
  command: string,
  ctx: ExecContext,
  handle: ExecHandle,
  migratedHardTimeoutMs: number,
): ToolTask {
  const pid = handle.child.pid ?? -1;
  return {
    kind: 'tool',
    id: fullId,
    shortId: shortId,
    toolName: EXEC_TOOL_NAME,
    args: { command },
    parentClawDir: ctx.clawDir,
    parentClawId: ctx.clawId,
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
    toolUseId: ctx.currentToolUseId,
    mode: 'migrated',
    migratedPid: pid,
    migratedStartTime: pid > 0 ? getProcessStartTime(pid) : undefined,
    migratedDeadlineMs: Date.now() + migratedHardTimeoutMs,
  };
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
  const { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed, parentStreamLog, shortIdIndex } = deps;
  const sendToolResult = deps.sendToolResult ?? defaultSendToolResult;
  const sendFallbackError = deps.sendFallbackError ?? defaultSendFallbackError;

  const tool: Tool = {
    name: EXEC_TOOL_NAME,
    profiles: ['full'],  // Phase 773: wrapper is only for the main agent; subagents use plain sync exec.
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
            return processExecErrorToToolResult(err, command);
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
          return processExecErrorToToolResult(err, command);
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

      // Phase 849: dual-key task IDs. fullId for persistence, shortId for agent output.
      let fullId: FullTaskId;
      let shortId: ShortTaskId;
      do {
        fullId = makeFullTaskId(newUuid());
        shortId = shortIdIndex.deriveShortId(fullId);
      } while (shortIdIndex.has(shortId));

      const task = buildMigratedToolTask(fullId, shortId, command, ctx, handle, migratedHardTimeoutMs);

      try {
        await persistRunningTask(fs, task);
        // Only register index after successful file write to avoid dangling entries.
        shortIdIndex.add(shortId, fullId);
        shortIdIndex.save();
      } catch (persistErr) {
        // Migration persistence failed: kill the child and report error.
        handle.child.kill('SIGTERM');
        auditWriter.write(
          TASK_AUDIT_EVENTS.HANDLER_FAILED,
          `taskId=${task.id}`,
          `context=async_exec_wrapper_persist_failed`,
          `error=${formatErr(persistErr)}`,
        );
        return { success: false, content: `Failed to persist migrated exec task: ${formatErr(persistErr)}` };
      }

      // Migration persisted: notify viewport that a background exec task started.
      const startedAt = Date.now();
      parentStreamLog?.write({
        ts: startedAt,
        type: STREAM_TASK_EVENTS.TASK_STARTED,
        taskId: shortId,
        fullTaskId: fullId,
        taskKind: 'exec_migrated',
        silent: false,
        command: command.length > 80 ? `${command.slice(0, 80)}...` : command,
        startedAt,
      });

      // Create result.txt with the partial output collected so far and switch
      // stdout/stderr listeners to append future chunks to the file in real time.
      // Use synchronous I/O for the initial write so no stdout/stderr data can
      // arrive while the listener is still the old in-memory collector.
      const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
      fs.ensureDirSync(resultDir);
      const resultPath = path.join(resultDir, 'result.txt');
      fs.writeAtomicSync(resultPath, partialOutput);

      const appendToFile = (chunk: Buffer): void => {
        fs.appendSync(resultPath, chunk.toString());
      };
      handle.child.stdout?.removeAllListeners('data');
      handle.child.stderr?.removeAllListeners('data');
      handle.child.stdout?.on('data', appendToFile);
      handle.child.stderr?.on('data', appendToFile);

      // Background chain: wait for the process to exit, then ask the async task
      // system to deliver the result. result.txt is kept up-to-date in real
      // time by the append listeners above, so no additional persistence is
      // needed.
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

          await Promise.race([handle.promise, hardTimeout]);

          await executeToolTask(
            task,
            () => Promise.resolve({ success: true, content: '' }),
            new AbortController().signal,
            { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed, sendToolResult, sendFallbackError, writeInboxAsync: deps.writeInboxAsync },
          );
        } catch (monitorErr) {
          // Hard timeout or process exited with an error: kill if we timed out,
          // append an error marker to result.txt, then still try to deliver.
          if (timedOut) {
            handle.child.kill('SIGTERM');
            auditWriter.write(
              TASK_AUDIT_EVENTS.TASK_MIGRATED_TIMED_OUT,
              `taskId=${task.id}`,
              `pid=${handle.child.pid}`,
            );
          }

          try {
            const errorMarker =
              `\n[Process ${timedOut ? 'timed out' : 'exited with error'}: ${formatErr(monitorErr)}]`;
            fs.appendSync(resultPath, errorMarker);
          } catch (persistErr) {
            emitHandlerFailed(auditWriter, {
              fullTaskId: task.id as FullTaskId,
              shortTaskId: taskShortId(task),
              context: 'async_exec_wrapper_append_error_marker',
              error: formatErr(persistErr),
            });
          }

          try {
            await executeToolTask(
              task,
              () => Promise.resolve({ success: true, content: '' }),
              new AbortController().signal,
              { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed, sendToolResult, sendFallbackError, writeInboxAsync: deps.writeInboxAsync },
            );
          } catch (execErr) {
            emitHandlerFailed(auditWriter, {
              fullTaskId: task.id as FullTaskId,
              shortTaskId: taskShortId(task),
              context: 'async_exec_wrapper_monitor',
              error: formatErr(execErr),
            });
          }
        }
        // Emit completion event on both success and failure paths so the viewport
        // removes the migrated exec indicator.
        parentStreamLog?.write({
          ts: Date.now(),
          type: STREAM_TASK_EVENTS.TASK_COMPLETED,
          taskId: shortId,
          fullTaskId: fullId,
          taskKind: 'exec_migrated',
        });
      })();

      // Fire-and-forget: do not await the background chain in the caller path.
      backgroundMonitor.catch((err) => {
        emitHandlerFailed(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          context: 'async_exec_wrapper_background',
          error: formatErr(err),
        });
      });

      auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_MIGRATED_REGISTERED,
        `taskId=${task.id}`,
        `pid=${task.migratedPid}`,
        `command=${command}`,
      );

      const resultRelPath = path.join('..', resultDir, 'result.txt');

      return {
        success: true,
        content: `Execution moved to async. Task: ${shortId}. Output streaming to ${resultRelPath} — use read to check progress.`,
        metadata: { taskId: shortId, fullTaskId: fullId, async: true, migrated: true },
      };
    },
  };
  return tool;
}
