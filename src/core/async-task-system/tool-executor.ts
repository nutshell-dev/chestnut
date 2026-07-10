import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolTask, FullTaskId } from './types.js';
import { taskShortId } from './types.js';
import { sendToolResult, sendFallbackError } from './result-delivery.js';
import { formatErr, classifyTaskError } from './_helpers.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { getProcessStartTime } from '../../foundation/process-exec/index.js';
import {
  emitTaskCompleted,
  emitHandlerFailed,
  emitToolRetry,
  emitToolAsyncResult,
} from './audit-emit.js';
import { TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import type { TaskId } from './types.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';


interface ExecuteToolTaskDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  retryBaseDelayMs: number;
  moveTaskToDone: (taskId: TaskId) => Promise<void>;
  moveTaskToFailed: (taskId: TaskId) => Promise<void>;
}


/**
 * Read persisted migrated result from disk.
 * Returns a fallback message if the file is missing.
 */
async function readMigratedResult(fs: FileSystem, taskId: TaskId): Promise<string> {
  try {
    return await fs.read(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt`);
  } catch (err) {
    if (isFileNotFound(err)) {
      return '(no output)';
    }
    throw err;
  }
}

/**
 * Execute a migrated tool task: monitor an already-running process and deliver
 * its result once it exits. This path does not spawn a new process.
 */
async function executeMigratedToolTask(
  task: ToolTask,
  _signal: AbortSignal,
  deps: ExecuteToolTaskDeps,
): Promise<void> {
  const { fs, auditWriter, moveTaskToDone, moveTaskToFailed } = deps;
  const taskStartTime = Date.now();

  // PID reuse defense: verify the running process has the expected start time.
  // The wrapper guarantees the process has exited before calling executeToolTask,
  // but we keep the check to defend against an extremely unlikely PID reuse race.
  if (task.migratedStartTime !== undefined && task.migratedPid !== undefined) {
    const actualStartTime = getProcessStartTime(task.migratedPid);
    if (actualStartTime !== undefined && actualStartTime !== task.migratedStartTime) {
      auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_MIGRATED_PID_REUSED,
        `taskId=${task.id}`,
        `pid=${task.migratedPid}`,
        `expected=${task.migratedStartTime}`,
        `actual=${actualStartTime}`,
      );
      const errorMsg = 'Migrated process PID reused';
      await sendToolResult(fs, auditWriter, task, errorMsg, true).catch((sendErr) => {
        emitHandlerFailed(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          context: 'sendFallbackError_migrated_pid_reused',
          error: formatErr(sendErr),
        });
      });
      emitTaskCompleted(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        status: 'err',
        kind: 'tool',
        toolName: task.toolName,
        errorCategory: classifyTaskError(errorMsg),
        elapsedMs: Date.now() - taskStartTime,
      });
      await moveTaskToFailed(task.id);
      return;
    }
  }

  // The wrapper already waited for the process to exit and wrote the full
  // result.txt; just read and deliver it.
  const resultContent = await readMigratedResult(fs, task.id);
  const result: ToolResult = { success: true, content: resultContent };

  try {
    await sendToolResult(fs, auditWriter, task, result, false);
  } catch (sendErr) {
    await sendFallbackError(fs, auditWriter, task, 'Failed to send migrated result').catch((e) => {
      emitHandlerFailed(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        context: 'sendFallbackError_migrated_result',
        error: formatErr(e),
      });
    });
  }

  emitTaskCompleted(auditWriter, {
    fullTaskId: task.id as FullTaskId,
    shortTaskId: taskShortId(task),
    status: 'ok',
    kind: 'tool',
    toolName: task.toolName,
    elapsedMs: Date.now() - taskStartTime,
  });

  if (task.toolUseId) {
    emitToolAsyncResult(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      toolName: task.toolName,
      toolUseId: task.toolUseId,
    });
  }

  auditWriter.write(
    TASK_AUDIT_EVENTS.TASK_MIGRATED_COMPLETED,
    `taskId=${task.id}`,
    `pid=${task.migratedPid}`,
  );

  await moveTaskToDone(task.id);
}

/**
 * Execute a tool task - internal method
 * Implements retry logic for idempotent tools with exponential backoff
 */
export async function executeToolTask(
  task: ToolTask,
  executeCallback: () => Promise<ToolResult>,
  signal: AbortSignal,
  deps: ExecuteToolTaskDeps,
): Promise<void> {
  // Phase 770: migrated path monitors an already-running process.
  if (task.mode === 'migrated') {
    await executeMigratedToolTask(task, signal, deps);
    return;
  }

  const { fs, auditWriter, retryBaseDelayMs, moveTaskToDone, moveTaskToFailed } = deps;
  const taskStartTime = Date.now();
  let lastError: string | undefined;
  let success = false;
  const maxAttempts = task.maxRetries + 1; // Initial + retries

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check abort signal before each attempt
    if (signal.aborted) {
      lastError = 'Execution aborted';
      break;
    }

    try {
      const result = await executeCallback();
      // Success - send result and mark success
      try {
        await sendToolResult(fs, auditWriter, task, result, false);
      } catch (sendErr) {
        // sendToolResult 本身失败：降级写最小通知，不进入重试（执行已成功）
        await sendFallbackError(fs, auditWriter, task, 'Failed to send result').catch((e) => {
          emitHandlerFailed(auditWriter, {
            fullTaskId: task.id as FullTaskId,
            shortTaskId: taskShortId(task),
            context: 'sendFallbackError_error_path',
            error: formatErr(e),
          });
        });
      }
      success = true;
      emitTaskCompleted(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        status: 'ok',
        kind: 'tool',
        toolName: task.toolName,
        elapsedMs: Date.now() - taskStartTime,
        retries: attempt,
      });
      // tool_async_result：仅当 toolUseId 已记录时写入
      if (task.toolUseId) {
        emitToolAsyncResult(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          toolName: task.toolName,
          toolUseId: task.toolUseId,
        });
      }
      break; // Exit retry loop on success
    } catch (error) {
      const errorMsg = formatErr(error);
      lastError = errorMsg;

      // Check if we should retry
      if (attempt < task.maxRetries) {
        // Update retry count in task and persist to running file
        task.retryCount = attempt + 1;
        try {
          await fs.writeAtomic(
            `${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`,
            JSON.stringify(task, null, 2)
          );
        } catch (writeErr) {
          // Non-critical: just log
          emitHandlerFailed(auditWriter, {
            fullTaskId: task.id as FullTaskId,
            shortTaskId: taskShortId(task),
            context: 'retry_count_update',
            error: formatErr(writeErr),
          });
        }

        emitToolRetry(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          tool: task.toolName,
          attempt: attempt + 1,
          max: task.maxRetries,
          error: errorMsg,
        });

        // Exponential backoff: retryBaseDelayMs, retryBaseDelayMs*2, etc.
        const backoffMs = retryBaseDelayMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, backoffMs));

        // Check abort signal after sleep
        if (signal.aborted) {
          lastError = 'Execution aborted during retry wait';
          break;
        }
      }
      // Continue to next retry attempt
    }
  }

  // If not successful after all attempts, send error result
  if (!success) {
    const finalError = lastError || 'Unknown error';
    try {
      await sendToolResult(
        fs,
        auditWriter,
        task,
        task.maxRetries > 0
          ? `Execution failed after ${task.retryCount} retries: ${finalError}`
          : finalError,
        true
      );
    } catch (sendErr) {
      // sendToolResult 失败：降级写最小通知
      await sendFallbackError(fs, auditWriter, task, finalError).catch((e) => {
        emitHandlerFailed(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          context: 'sendFallbackError_retry',
          error: formatErr(e),
        });
      });
    }

    emitHandlerFailed(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      tool: task.toolName,
      context: 'retries_exhausted',
      error: finalError,
    });
    emitTaskCompleted(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      status: 'err',
      kind: 'tool',
      toolName: task.toolName,
      errorCategory: classifyTaskError(lastError),
      elapsedMs: Date.now() - taskStartTime,
    });
  }

  // Move from running to done/failed based on success
  if (success) {
    await moveTaskToDone(task.id);
  } else {
    await moveTaskToFailed(task.id);
  }
}
