import { newUuid } from '../../foundation/node-utils/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { InboxMessage } from '../../foundation/messaging/index.js';
import { writeInboxAsync } from '../../foundation/messaging/index.js';
import { INBOX_PENDING_DIR } from '../../foundation/messaging/index.js';
import { formatErr } from './_helpers.js';
import {
  emitResultWriteFailed,
  emitInboxWriteFailed,
  emitResultDeliveryEnsureDirFailed,
} from './audit-emit.js';
import { TASKS_QUEUES_RESULTS_DIR } from './dirs.js';

import type { SubAgentTask, ToolTask, FullTaskId, ShortTaskId } from './types.js';
import { deriveShortIdFromTaskId, taskShortId } from './types.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { TaskId } from './types.js';
import type { ResultDeliveryDeps } from './result-delivery-types.js';



export const SENT_MARKER = (taskId: TaskId): string =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.sent`;

async function writeSentMarker(
  fs: FileSystem,
  auditWriter: AuditLog,
  taskId: TaskId,
  shortId?: ShortTaskId,
): Promise<boolean> {
  try {
    await fs.writeAtomic(SENT_MARKER(taskId), '1');
    return true;
  } catch (markerErr) {
    // 不 throw：marker 写失败仅影响 future recovery 重发 → at-least-once 投递（≤ 10ms race window 已 design ratify ⚓ accepted-stable by phase 875、consumer 容忍重发、详 design/modules/l4_async_task_system.md §7.B B.sent-marker-residual-race-window）
    emitResultWriteFailed(auditWriter, {
      fullTaskId: taskId as FullTaskId,
      shortTaskId: shortId ?? deriveShortIdFromTaskId(taskId),
      context: 'sent_marker_persist_failed',
      error: formatErr(markerErr),
    });
    return false;
  }
}

export type { ResultDeliveryDeps } from './result-delivery-types.js';

interface SendResultCoreParams {
  fs: FileSystem;
  auditWriter: AuditLog;
  taskId: TaskId;
  shortId: ShortTaskId;
  parentClawId: string;
  fullContent: string;
  buildInlineJson: () => string;
  buildRefJson: (resultRef: string, summary: string) => string;
  isError: boolean;
  writeMarkerOnSuccess: boolean;
  auditContexts: {
    initialWrite: string;
    orphanDelete: string;
  };
  deps?: ResultDeliveryDeps;
}

/**
 * Shared write-result-to-inbox control flow (phase 16 Step C / audit M1).
 *
 * Three-level degradation:
 *   1. write result.txt + ref message  → fail: degrade to inline message
 *   2. write inbox (ref)               → fail: delete orphan ref + retry inline
 *   3. write inbox (inline retry)      → fail: emit inline_fallback_failed +
 *      re-throw original err (caller fallback chain unchanged)
 */
/**
 * Inbox result summary cap — owned by result-delivery (convergent 500 with audit summary cap).
 * Derivation: 500 char ≈ 1-2 段中文 / 配 audit summary 同值（500）形成 convergent boundary /
 * 比 TEXT_BUFFER_CAP (64KB) 小 100×+ 因 summary 是 distilled 摘要 / 防 inbox 内单 entry 灌爆.
 */
const TASK_RESULT_SUMMARY_MAX_CHARS = 500;

async function sendResultCore(p: SendResultCoreParams): Promise<void> {
  const writeInbox = p.deps?.writeInboxAsync ?? writeInboxAsync;
  let resultRef: string | undefined;
  try {
    const resultPath = `${TASKS_QUEUES_RESULTS_DIR}/${p.taskId}/result.txt`;
    await p.fs.ensureDir(`${TASKS_QUEUES_RESULTS_DIR}/${p.taskId}`);
    await p.fs.writeAtomic(resultPath, p.fullContent);
    resultRef = resultPath;
  } catch (writeErr) {
    emitResultWriteFailed(p.auditWriter, {
      fullTaskId: p.taskId as FullTaskId,
      shortTaskId: p.shortId,
      context: p.auditContexts.initialWrite,
      error: formatErr(writeErr),
    });
  }

  const summary = resultRef ? p.fullContent.slice(0, TASK_RESULT_SUMMARY_MAX_CHARS) : p.fullContent;
  const inlineContent = p.buildInlineJson();
  const messageContent = resultRef ? p.buildRefJson(resultRef, summary) : inlineContent;

  const baseMsg: InboxMessage = {
    id: newUuid(),
    type: 'task_result',
    from: 'system',
    to: p.parentClawId,
    content: messageContent,
    priority: p.isError ? 'high' : 'normal',
    timestamp: new Date().toISOString(),
  };

  try {
    await writeInbox(p.fs, INBOX_PENDING_DIR, baseMsg, p.auditWriter);
  } catch (err) {
    if (resultRef) {
      try {
        await writeInbox(p.fs, INBOX_PENDING_DIR, { ...baseMsg, content: inlineContent }, p.auditWriter);
        // Persist sent marker BEFORE deleting resultRef.
        // If crash occurs between marker and delete, recovery sees marker and skips re-send.
        let markerOk = true;
        if (p.writeMarkerOnSuccess) {
          markerOk = await writeSentMarker(p.fs, p.auditWriter, p.taskId, p.shortId);
        }
        if (markerOk) {
          // Only delete resultRef if marker was persisted.
          // If marker failed, keep resultRef — recovery will re-send on next startup.
          await p.fs.delete(resultRef).catch((delErr) => {
            emitResultWriteFailed(p.auditWriter, {
              fullTaskId: p.taskId as FullTaskId,
              shortTaskId: p.shortId,
              context: p.auditContexts.orphanDelete,
              error: formatErr(delErr),
            });
          });
        }
        // If marker failed, resultRef is preserved — don't delete it.
        return;
      } catch (inlineErr) {
        emitInboxWriteFailed(p.auditWriter, {
          fullTaskId: p.taskId as FullTaskId,
          shortTaskId: p.shortId,
          context: 'inline_fallback_failed',
          error: formatErr(inlineErr),
        });
        // resultRef preserved — can be read manually or retried on next recovery
      }
    }
    emitInboxWriteFailed(p.auditWriter, {
      fullTaskId: p.taskId as FullTaskId,
      shortTaskId: p.shortId,
      error: formatErr(err),
    });
    throw err;
  }

  if (p.writeMarkerOnSuccess) {
    // phase 789 (audit-2026-05-14 P0.19): SENT_MARKER = "parent inbox has
    // received at least one notification for this task" idempotency token;
    // recovery checks the marker to decide whether to skip re-send.
    // Marker failure is swallowed (returns false) so recovery can re-send the
    // still-present result.txt on next startup.
    await writeSentMarker(p.fs, p.auditWriter, p.taskId, p.shortId);
  }
}

/**
 * Send tool task result to parent claw's inbox.
 * Large outputs are offloaded to TASKS_QUEUES_RESULTS_DIR/{taskId}.txt.
 * No SENT_MARKER for tool tasks: _recoverToolTask re-queues; idempotency
 * is the caller's contract (ToolTask.isIdempotent).
 */
export async function sendToolResult(
  fs: FileSystem,
  auditWriter: AuditLog,
  task: ToolTask,
  result: ToolResult | string,
  isError: boolean,
  deps?: ResultDeliveryDeps,
): Promise<void> {
  const fullContent = typeof result === 'string' ? result : result.content;
  const shortId = taskShortId(task);
  await sendResultCore({
    fs,
    auditWriter,
    taskId: task.id,
    shortId,
    parentClawId: task.parentClawId,
    fullContent,
    buildInlineJson: () => JSON.stringify({
      taskId: shortId,
      fullTaskId: task.id as FullTaskId,
      toolName: task.toolName,
      result: fullContent,
      is_error: isError,
    }),
    buildRefJson: (resultRef, summary) => JSON.stringify({
      taskId: shortId,
      fullTaskId: task.id as FullTaskId,
      toolName: task.toolName,
      summary,
      resultRef,
      is_error: isError,
    }),
    isError,
    writeMarkerOnSuccess: false,
    auditContexts: { initialWrite: 'write_result', orphanDelete: 'orphan_delete' },
    deps,
  });
}

/**
 * Send subagent task result to parent claw's inbox.
 * Large outputs are offloaded to TASKS_QUEUES_RESULTS_DIR/{taskId}.txt.
 * Writes SENT_MARKER on success — recovery uses it to skip re-send.
 */
export async function sendResult(
  fs: FileSystem,
  auditWriter: AuditLog,
  task: SubAgentTask,
  result: string,
  isError: boolean,
  deps?: ResultDeliveryDeps,
): Promise<void> {
  const shortId = taskShortId(task);
  await sendResultCore({
    fs,
    auditWriter,
    taskId: task.id,
    shortId,
    parentClawId: task.parentClawId,
    fullContent: result,
    buildInlineJson: () => JSON.stringify({
      taskId: shortId,
      fullTaskId: task.id as FullTaskId,
      result,
      is_error: isError,
    }),
    buildRefJson: (resultRef, summary) => JSON.stringify({
      taskId: shortId,
      fullTaskId: task.id as FullTaskId,
      summary,
      resultRef,
      is_error: isError,
    }),
    isError,
    writeMarkerOnSuccess: true,
    auditContexts: { initialWrite: 'send_result_write', orphanDelete: 'orphan_delete_send' },
    deps,
  });
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
  deps?: ResultDeliveryDeps,
): Promise<void> {
  const writeInbox = deps?.writeInboxAsync ?? writeInboxAsync;
  const msgId = newUuid();
  const msg: InboxMessage = {
    id: msgId,
    type: 'task_result',
    from: 'system',
    to: task.parentClawId,
    content: JSON.stringify({
      taskId: taskShortId(task),
      fullTaskId: task.id,
      is_error: true,
      result: `Task failed: ${errorMsg}`,
    }),
    priority: 'high',
    timestamp: new Date().toISOString(),
  };
  await writeInbox(fs, INBOX_PENDING_DIR, msg, auditWriter);

  // phase 789 (audit-2026-05-14 P0.20): SubAgentTask fallback inbox success → 写 SENT_MARKER
  // 防止 next recovery 重发 sendResult 导致父 inbox 收 fallback + real result 双投递
  // ToolTask 不写（无 SENT_MARKER 语义 / _recoverToolTask 仅 re-queue）
  if (task.kind === 'subagent') {
    const resultsDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    await fs.ensureDir(resultsDir).catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      // EEXIST 路径 idempotent 安全，silent 合规；非 EEXIST 是真 fs 故障，audit 留痕
      if (code !== 'EEXIST') {
        const msg = formatErr(err);
        emitResultDeliveryEnsureDirFailed(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          dir: resultsDir,
          code: code ?? 'UNKNOWN',
          error: msg,
        });
      }
    });
    await writeSentMarker(fs, auditWriter, task.id, taskShortId(task));
  }
}
