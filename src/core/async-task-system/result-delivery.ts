import { randomUUID } from 'crypto';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { InboxMessage } from '../../foundation/messaging/types.js';
import { writeInboxAsync } from '../../foundation/messaging/index.js';
import { formatErr } from './_helpers.js';
import {
  emitResultWriteFailed,
  emitInboxWriteFailed,
  emitResultDeliveryEnsureDirFailed,
} from './audit-emit.js';
import { TASKS_QUEUES_RESULTS_DIR } from './dirs.js';
import { SUMMARY_MAX_CHARS } from '../../foundation/utils/format.js';
import type { SubAgentTask, ToolTask } from './types.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

export const SENT_MARKER = (taskId: string): string =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.sent`;

async function writeSentMarker(fs: FileSystem, auditWriter: AuditLog, taskId: string): Promise<void> {
  try {
    await fs.writeAtomic(SENT_MARKER(taskId), '1');
  } catch (markerErr) {
    // 不 throw：marker 写失败仅影响 future recovery 重发 → at-least-once 投递（≤ 10ms race window 已 design ratify ⚓ accepted-stable by phase 875、consumer 容忍重发、详 design/modules/l4_async_task_system.md §7.B B.sent-marker-residual-race-window）
    emitResultWriteFailed(auditWriter, {
      taskId,
      context: 'sent_marker_persist_failed',
      error: formatErr(markerErr),
    });
  }
}

/**
 * Send tool task result to parent claw's inbox
 * Large outputs are offloaded to TASKS_QUEUES_RESULTS_DIR/{taskId}.txt
 * Writes directly to inbox/pending/ in .md format (standard inbox format)
 */
export async function sendToolResult(
  fs: FileSystem,
  auditWriter: AuditLog,
  task: ToolTask,
  result: ToolResult | string,
  isError: boolean,
): Promise<void> {
  const fullContent = typeof result === 'string' ? result : result.content;

  // Try to write full result to TASKS_QUEUES_RESULTS_DIR/
  let resultRef: string | undefined;
  try {
    const resultPath = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt`;
    await fs.ensureDir(`${TASKS_QUEUES_RESULTS_DIR}/${task.id}`);
    await fs.writeAtomic(resultPath, fullContent);
    resultRef = resultPath;
  } catch (writeErr) {
    // Degrade gracefully: resultRef remains undefined, send full content in inbox
    const errMsg = formatErr(writeErr);
    emitResultWriteFailed(auditWriter, {
      taskId: task.id,
      context: 'write_result',
      error: errMsg,
    });
  }

  // Build summary (preview if resultRef exists, full content otherwise)
  const summary = resultRef ? fullContent.slice(0, SUMMARY_MAX_CHARS) : fullContent;

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
    await writeInboxAsync(fs, 'inbox/pending', baseMsg, auditWriter);
  } catch (err) {
    if (resultRef) {
      // inbox 写失败：删除孤立的 results 文件，降级为 inline 内容重试
      await fs.delete(resultRef).catch((delErr) => {
        emitResultWriteFailed(auditWriter, {
          taskId: task.id,
          context: 'orphan_delete',
          error: formatErr(delErr),
        });
      });
      try {
        await writeInboxAsync(fs, 'inbox/pending', { ...baseMsg, content: inlineContent }, auditWriter);
        return;
      } catch (inlineErr) {
        emitInboxWriteFailed(auditWriter, {
          taskId: task.id,
          context: 'inline_fallback_failed',
          error: formatErr(inlineErr),
        });
        // 降级也失败，继续抛出原始错误（保 caller fallback 链 / 既有 throw err 路径不动）
      }
    }
    const errMsg = formatErr(err);
    emitInboxWriteFailed(auditWriter, {
      taskId: task.id,
      error: errMsg,
    });
    throw err;  // Re-throw to allow caller fallback
  }
}

/**
 * Send task result to parent claw's inbox
 * Large outputs are offloaded to TASKS_QUEUES_RESULTS_DIR/{taskId}.txt
 */
export async function sendResult(
  fs: FileSystem,
  auditWriter: AuditLog,
  task: SubAgentTask,
  result: string,
  isError: boolean,
): Promise<void> {
  // Try to write full result to TASKS_QUEUES_RESULTS_DIR/
  let resultRef: string | undefined;
  try {
    const resultPath = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt`;
    await fs.ensureDir(`${TASKS_QUEUES_RESULTS_DIR}/${task.id}`);
    await fs.writeAtomic(resultPath, result);
    resultRef = resultPath;
  } catch (writeErr) {
    // Degrade gracefully: resultRef remains undefined, send full content in inbox
    const errMsg = formatErr(writeErr);
    emitResultWriteFailed(auditWriter, {
      taskId: task.id,
      context: 'send_result_write',
      error: errMsg,
    });
  }

  // Build summary (preview if resultRef exists, full content otherwise)
  const summary = resultRef ? result.slice(0, SUMMARY_MAX_CHARS) : result;

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
    await writeInboxAsync(fs, 'inbox/pending', baseMsg, auditWriter);
  } catch (err) {
    if (resultRef) {
      // inbox 写失败：删除孤立的 results 文件，降级为 inline 内容重试
      await fs.delete(resultRef).catch((delErr) => {
        emitResultWriteFailed(auditWriter, {
          taskId: task.id,
          context: 'orphan_delete_send',
          error: formatErr(delErr),
        });
      });
      try {
        await writeInboxAsync(fs, 'inbox/pending', { ...baseMsg, content: inlineContent }, auditWriter);
        // phase 789: inline fallback success 也算 inbox 已投递 → 写 SENT_MARKER
        await writeSentMarker(fs, auditWriter, task.id);
        return;
      } catch (inlineErr) {
        emitInboxWriteFailed(auditWriter, {
          taskId: task.id,
          context: 'inline_fallback_failed',
          error: formatErr(inlineErr),
        });
        // 降级也失败，继续抛出原始错误（保 caller fallback 链 / 既有 throw err 路径不动）
      }
    }
    const errMsg = formatErr(err);
    emitInboxWriteFailed(auditWriter, {
      taskId: task.id,
      error: errMsg,
    });
    throw err;  // Re-throw to allow caller fallback
  }
  // phase 789 (audit-2026-05-14 P0.19): inbox 主路径 success → 原子写 SENT_MARKER
  // SENT_MARKER 是「父 inbox 已投递关于本 task 的至少一条通知」的 idempotency token
  // crash recovery 检 marker 决定是否跳重发
  await writeSentMarker(fs, auditWriter, task.id);
}

/**
 * Send fallback error message directly to inbox (bypassing results file)
 * Used when sendResult fails to ensure parent is not left hanging
 */
export async function sendFallbackError(
  fs: FileSystem,
  auditWriter: AuditLog,
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
  await writeInboxAsync(fs, 'inbox/pending', msg, auditWriter);

  // phase 789 (audit-2026-05-14 P0.20): SubAgentTask fallback inbox success → 写 SENT_MARKER
  // 防止 next recovery 重发 sendResult 导致父 inbox 收 fallback + real result 双投递
  // ToolTask 不写（无 SENT_MARKER 语义 / _recoverToolTask 仅 re-queue）
  if (task.kind === 'subagent') {
    const resultsDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    await fs.ensureDir(resultsDir).catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      // EEXIST 路径 idempotent 安全，silent 合规；非 EEXIST 是真 fs 故障，audit 留痕
      if (code !== 'EEXIST') {
        const msg = err instanceof Error ? err.message : String(err);
        emitResultDeliveryEnsureDirFailed(auditWriter, {
          taskId: task.id,
          dir: resultsDir,
          code: code ?? 'UNKNOWN',
          error: msg,
        });
      }
    });
    await writeSentMarker(fs, auditWriter, task.id);
  }
}
