import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolTask } from './system.js';
import { sendToolResult, sendFallbackError } from './result-delivery.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { formatErr, auditError, classifyTaskError } from './_helpers.js';
import { TASKS_QUEUES_RUNNING_DIR } from '../../types/paths.js';

export interface ExecuteToolTaskDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  retryBaseDelayMs: number;
  moveTaskToDone: (taskId: string) => Promise<void>;
  moveTaskToFailed: (taskId: string) => Promise<void>;
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
          auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=sendFallbackError_error_path', `error=${formatErr(e)}`);
        });
      }
      success = true;
      auditWriter.write(
        TASK_AUDIT_EVENTS.TASK_COMPLETED,
        task.id, 'ok',
        `kind=tool`,
        `toolName=${task.toolName}`,
        `elapsed_ms=${Date.now() - taskStartTime}`,
        `retries=${attempt}`,
      );
      // tool_async_result：仅当 toolUseId 已记录时写入
      if (task.toolUseId) {
        auditWriter.write('tool_async_result', task.toolName, task.toolUseId, `task=${task.id}`);
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
          auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=retry_count_update', `error=${formatErr(writeErr)}`);
        }

        auditWriter.write(TASK_AUDIT_EVENTS.TOOL_RETRY, task.id, `tool=${task.toolName}`, `attempt=${attempt + 1}`, `max=${task.maxRetries}`, `error=${errorMsg}`);

        // Exponential backoff: retryBaseDelayMs, retryBaseDelayMs*2, etc.
        const backoffMs = retryBaseDelayMs * (attempt + 1);
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
        auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, 'context=sendFallbackError_retry', `error=${formatErr(e)}`);
      });
    }

    auditWriter.write(TASK_AUDIT_EVENTS.HANDLER_FAILED, task.id, `tool=${task.toolName}`, 'context=retries_exhausted', `error=${finalError}`);
    auditWriter.write(
      TASK_AUDIT_EVENTS.TASK_COMPLETED,
      task.id, 'err',
      `kind=tool`,
      `toolName=${task.toolName}`,
      `error_category=${classifyTaskError(lastError)}`,
      `elapsed_ms=${Date.now() - taskStartTime}`,
    );
  }

  // Move from running to done/failed based on success
  if (success) {
    await moveTaskToDone(task.id);
  } else {
    await moveTaskToFailed(task.id);
  }
}
