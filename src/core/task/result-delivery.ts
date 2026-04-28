import { randomUUID } from 'crypto';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditWriter } from '../../foundation/audit/writer.js';
import type { InboxMessage } from '../../types/messaging.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { INBOX_PENDING_DIR } from '../../types/paths.js';
import type { SubAgentTask, ToolTask } from './system.js';
import type { ToolResult } from '../tools/executor.js';

/**
 * Send tool task result to parent claw's inbox
 * Large outputs are offloaded to tasks/results/{taskId}.txt
 * Writes directly to inbox/pending/ in .md format (standard inbox format)
 */
export async function sendToolResult(
  fs: FileSystem,
  auditWriter: AuditWriter,
  task: ToolTask,
  result: ToolResult | string,
  isError: boolean,
): Promise<void> {
  const fullContent = typeof result === 'string' ? result : result.content;

  // Try to write full result to tasks/results/
  let resultRef: string | undefined;
  try {
    const resultPath = `tasks/results/${task.id}/result.txt`;
    await fs.ensureDir(`tasks/results/${task.id}`);
    await fs.writeAtomic(resultPath, fullContent);
    resultRef = resultPath;
  } catch (writeErr) {
    // Degrade gracefully: resultRef remains undefined, send full content in inbox
    const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    auditWriter?.write(TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED, task.id, 'context=write_result', `error=${errMsg}`);
  }

  // Build summary (preview if resultRef exists, full content otherwise)
  const summary = resultRef ? fullContent.slice(0, 500) : fullContent;

  // Pre-compute both versions of message content (ref and inline)
  const inlineContent = JSON.stringify({
    taskId: task.id,
    toolName: task.toolName,
    result: fullContent,
    is_error: isError,
  });
  const messageContent = resultRef
    ? JSON.stringify({
        taskId: task.id,
        toolName: task.toolName,
        summary,
        resultRef,
        is_error: isError,
      })
    : inlineContent;

  const msgId = randomUUID();
  const priority: 'high' | 'normal' = isError ? 'high' : 'normal';
  const baseMsg: InboxMessage = {
    id: msgId,
    type: 'message',
    from: task.callerType ?? 'task_system',
    to: task.parentClawId,
    content: messageContent,
    priority,
    timestamp: new Date().toISOString(),
  };

  try {
    await new InboxWriter(fs, INBOX_PENDING_DIR, auditWriter).write(baseMsg);
  } catch (err) {
    if (resultRef) {
      // inbox 写失败：删除孤立的 results 文件，降级为 inline 内容重试
      await fs.delete(resultRef).catch((delErr) => {
        auditWriter?.write(TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED, task.id, 'context=orphan_delete', `error=${delErr instanceof Error ? delErr.message : JSON.stringify(delErr)}`);
      });
      try {
        await new InboxWriter(fs, INBOX_PENDING_DIR, auditWriter).write({ ...baseMsg, content: inlineContent });
        return;
      } catch {
        // 降级也失败，继续抛出原始错误
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[task] Failed to write inbox message for tool task ${task.id}:`, err);
    auditWriter?.write(TASK_AUDIT_EVENTS.INBOX_WRITE_FAILED, task.id, `error=${errMsg}`);
    throw err;  // Re-throw to allow caller fallback
  }
}

/**
 * Send task result to parent claw's inbox
 * Large outputs are offloaded to tasks/results/{taskId}.txt
 */
export async function sendResult(
  fs: FileSystem,
  auditWriter: AuditWriter,
  task: SubAgentTask,
  result: string,
  isError: boolean,
): Promise<void> {
  // Try to write full result to tasks/results/
  let resultRef: string | undefined;
  try {
    const resultPath = `tasks/results/${task.id}/result.txt`;
    await fs.ensureDir(`tasks/results/${task.id}`);
    await fs.writeAtomic(resultPath, result);
    resultRef = resultPath;
  } catch (writeErr) {
    // Degrade gracefully: resultRef remains undefined, send full content in inbox
    const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    auditWriter?.write(TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED, task.id, 'context=send_result_write', `error=${errMsg}`);
  }

  // Build summary (preview if resultRef exists, full content otherwise)
  const summary = resultRef ? result.slice(0, 500) : result;

  // Pre-compute both versions of message content (ref and inline)
  const inlineContent = JSON.stringify({
    taskId: task.id,
    result,
    is_error: isError,
  });
  const messageContent = resultRef
    ? JSON.stringify({
        taskId: task.id,
        summary,
        resultRef,
        is_error: isError,
      })
    : inlineContent;

  const msgId = randomUUID();
  const priority: 'high' | 'normal' = isError ? 'high' : 'normal';
  const baseMsg: InboxMessage = {
    id: msgId,
    type: 'message',
    from: task.callerType ?? 'subagent',
    to: task.parentClawId,
    content: messageContent,
    priority,
    timestamp: new Date().toISOString(),
  };

  try {
    await new InboxWriter(fs, INBOX_PENDING_DIR, auditWriter).write(baseMsg);
  } catch (err) {
    if (resultRef) {
      // inbox 写失败：删除孤立的 results 文件，降级为 inline 内容重试
      await fs.delete(resultRef).catch((delErr) => {
        auditWriter?.write(TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED, task.id, 'context=orphan_delete_send', `error=${delErr instanceof Error ? delErr.message : JSON.stringify(delErr)}`);
      });
      try {
        await new InboxWriter(fs, INBOX_PENDING_DIR, auditWriter).write({ ...baseMsg, content: inlineContent });
        return;
      } catch {
        // 降级也失败，继续抛出原始错误
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[task] Failed to write inbox message for task ${task.id}:`, err);
    auditWriter?.write(TASK_AUDIT_EVENTS.INBOX_WRITE_FAILED, task.id, `error=${errMsg}`);
    throw err;  // Re-throw to allow caller fallback
  }
}

/**
 * Send fallback error message directly to inbox (bypassing results file)
 * Used when sendResult fails to ensure parent is not left hanging
 */
export async function sendFallbackError(
  fs: FileSystem,
  auditWriter: AuditWriter,
  task: SubAgentTask | ToolTask,
  errorMsg: string,
): Promise<void> {
  const msgId = randomUUID();
  const msg: InboxMessage = {
    id: msgId,
    type: 'message',
    from: task.callerType ?? 'task_system',
    to: task.parentClawId,
    content: JSON.stringify({ taskId: task.id, is_error: true, result: `Task failed: ${errorMsg}` }),
    priority: 'high',
    timestamp: new Date().toISOString(),
  };
  await new InboxWriter(fs, INBOX_PENDING_DIR, auditWriter).write(msg);
}
