import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { SubAgentTask, ToolTask } from './system.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
} from './dirs.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from './_helpers.js';
import {
  emitRecovered,
  emitRecoveryComplete,
  emitRecoveryFailed,
  emitRecoveryDeadLetter,
} from './audit-emit.js';
import { validateTaskShape, backupCorruptTask } from './task-corrupt-helpers.js';
import { FileNotFoundError, isFileNotFound } from '../../foundation/fs/types.js';
import { sendFallbackError, sendResult, SENT_MARKER } from './result-delivery.js';

const RETRY_COUNT_PATH = (taskId: string) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.retry-count`;
const MAX_RECOVERY_RETRIES = 3;
// SENT_MARKER 迁 result-delivery.ts（写者归属 / phase 789）

/** M9: 闭包 ≥ 4 依赖 → deps interface */
export interface RecoverTasksDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  pendingQueue: Array<SubAgentTask | ToolTask>;
}

async function _recoverRunningTasks(deps: RecoverTasksDeps): Promise<number> {
  const { fs, auditWriter } = deps;
  let recoveredCount = 0;
  const runningEntries = await fs.list(TASKS_QUEUES_RUNNING_DIR);
  for (const entry of runningEntries) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const content = await fs.read(entry.path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        await backupCorruptTask(fs, auditWriter, entry.path, content, e);
        continue;
      }
      if (!validateTaskShape(parsed)) {
        await backupCorruptTask(fs, auditWriter, entry.path, content, new Error('shape_mismatch'));
        continue;
      }
      const task = parsed;
      if (task.kind === 'tool') {
        recoveredCount += await _recoverToolTask(deps, entry.path, task);
      } else {
        recoveredCount += await _recoverSubAgentTask(deps, entry.path, task);
      }
    } catch (err) {
      const errMsg = formatErr(err);
      emitRecoveryFailed(auditWriter, {
        path: entry.path,
        context: 'recover_running',
        error: errMsg,
      });
    }
  }
  return recoveredCount;
}

async function _recoverToolTask(
  deps: RecoverTasksDeps, filePath: string, task: ToolTask,
): Promise<number> {
  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
  await deps.fs.move(filePath, pendingPath);
  emitRecovered(deps.auditWriter, {
    taskId: task.id,
    kind: task.kind,
    from: 'running',
    to: 'pending',
  });
  return 1;
}

async function _recoverSubAgentTask(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask,
): Promise<number> {
  const resultPath = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt`;
  const sentMarker = SENT_MARKER(task.id);
  const alreadySent = await deps.fs.exists(sentMarker);
  const resultExists = !alreadySent && await deps.fs.exists(resultPath);

  if (alreadySent) {
    await _recoverAlreadySent(deps, filePath, task);
    return 0;
  } else if (resultExists) {
    return await _recoverWithResult(deps, filePath, task, resultPath);
  } else {
    return await _recoverWithoutResult(deps, filePath, task);
  }
}

async function _recoverAlreadySent(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask,
): Promise<void> {
  await deps.fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`).catch(async (moveErr) => {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'alreadysent_move_failed',
      error: formatErr(moveErr),
    });
    await deps.fs.delete(filePath).catch((delErr) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'alreadysent_delete_failed',
        error: formatErr(delErr),
      });
    });
  });
  // C.3 (phase 989): mirror _recoverWithResult line 166 cleanup / D5 hygiene / retry-count file 不 accumulate
  await deps.fs.delete(RETRY_COUNT_PATH(task.id)).catch(() => {});
  emitRecovered(deps.auditWriter, { taskId: task.id, reason: 'already_sent' });
}

async function _recoverWithResult(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, resultPath: string,
): Promise<number> {
  const { fs, auditWriter } = deps;
  const retryPath = RETRY_COUNT_PATH(task.id);

  let retryCount = 0;
  let counterCorrupt = false;
  try {
    const raw = await fs.read(retryPath);
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      counterCorrupt = true;
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'retry_counter_corrupt',
        raw: raw.slice(0, 80),
      });
    } else {
      retryCount = parsed;
    }
  } catch (err) {
    // phase 1154 r+ derive: 统一用 foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    // first-run / file 不存在 silent OK；其他 IO 错 audit（防 silent retry counter reset）
    if (!isFileNotFound(err)) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'retry_counter_read_failed',
        error: formatErr(err),
      });
    }
  }

  // counterCorrupt → force dead-letter promotion 防永循环 retry
  if (counterCorrupt) {
    retryCount = MAX_RECOVERY_RETRIES;
  }

  const resultContent = await fs.read(resultPath);
  const resultSent = await sendResult(fs, auditWriter, task, resultContent, false)
    .then(() => true)
    .catch(async (e) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'resend_result_failed',
        error: formatErr(e),
      });
      // phase 789 (audit-2026-05-14 P0.20): await sendFallbackError + 视作 sent
      // 防止 fallback 成功后 next startup 重试 sendResult 导致父 inbox 双投递
      // sendFallbackError 内会写 SENT_MARKER（phase 789 invariant）
      try {
        await sendFallbackError(fs, auditWriter, task, 'Result resend failed after recovery');
        return true;  // fallback delivered = inbox-written 视作 sent
      } catch (fallbackErr) {
        emitRecoveryFailed(auditWriter, {
          taskId: task.id,
          context: 'fallback_send_failed',
          error: formatErr(fallbackErr),
        });
        return false;  // both failed → retry next startup
      }
    });

  if (resultSent) {
    // phase 789: sendResult 内已写过此 marker，本处是 defensive idempotent backup
    await fs.writeAtomic(SENT_MARKER(task.id), '1').catch((e) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'sent_marker_persist_failed',
        error: formatErr(e),
      });
    });
    // retryPath delete 失败无害（残文件下次 startup 覆盖 / 不影响 dead-letter promotion）
    await fs.delete(retryPath).catch(() => {});
  } else {
    retryCount++;
    await fs.writeAtomic(retryPath, String(retryCount)).catch((e) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'retry_counter_persist_failed',
        error: formatErr(e),
      });
    });
    if (retryCount >= MAX_RECOVERY_RETRIES) {
      await _moveToDeadLetter(deps, filePath, task, retryCount, retryPath);
      return 0;
    }
    // P1.8 fix (phase 612): retryCount<MAX 时不 move DONE / 保 running/ /
    // 下次启动 recovery 再 trigger _recoverWithResult / counter 持久化 / 累至 MAX → dead-letter
    // 之前 fall-through 到 line 130 move DONE 是 silent drop bug（resultSent=false 但移 DONE / parent 永不收 / 下次启动 0 retry）
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'retry_pending',
      retryCount,
      maxRetries: MAX_RECOVERY_RETRIES,
    });
    return 0;
  }

  // 仅 success path 走这里 (resultSent=true)
  await fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`).catch(async (moveErr) => {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'done_move_failed',
      error: formatErr(moveErr),
    });
    await fs.delete(filePath).catch((delErr) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'done_delete_failed',
        error: formatErr(delErr),
      });
    });
  });
  emitRecovered(auditWriter, { taskId: task.id, reason: 'result_file_exists' });
  return 0;
}

async function _moveToDeadLetter(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, retryCount: number, retryPath: string,
): Promise<void> {
  const { fs, auditWriter } = deps;
  emitRecoveryDeadLetter(auditWriter, { taskId: task.id, retries: retryCount });
  await fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`).catch(async (moveErr) => {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'dead_letter_move_failed',
      error: formatErr(moveErr),
    });
    await fs.delete(filePath).catch((delErr) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'dead_letter_delete_failed',
        error: formatErr(delErr),
      });
    });
  });
  await fs.delete(retryPath).catch((cleanupErr) => {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'dead_letter_retrypath_cleanup_failed',
      error: formatErr(cleanupErr),
    });
  });
}

async function _recoverWithoutResult(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask,
): Promise<number> {
  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
  await deps.fs.move(filePath, pendingPath).catch(async (moveErr) => {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'without_result_move_failed',
      error: formatErr(moveErr),
    });
    await deps.fs.delete(filePath).catch((delErr) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'without_result_delete_failed',
        error: formatErr(delErr),
      });
    });
  });
  emitRecovered(deps.auditWriter, {
    taskId: task.id,
    kind: task.kind,
    from: 'running',
    to: 'pending',
  });
  return 1;
}

async function _loadPendingTasks(deps: RecoverTasksDeps): Promise<void> {
  const { fs, auditWriter } = deps;
  const pendingEntries = await fs.list(TASKS_QUEUES_PENDING_DIR);
  for (const entry of pendingEntries) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const content = await fs.read(entry.path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        await backupCorruptTask(fs, auditWriter, entry.path, content, e);
        continue;
      }
      if (!validateTaskShape(parsed)) {
        await backupCorruptTask(fs, auditWriter, entry.path, content, new Error('shape_mismatch'));
        continue;
      }
      // 文件保留 / by _initialScanPending 入队
    } catch (err) {
      const errMsg = formatErr(err);
      emitRecoveryFailed(auditWriter, {
        path: entry.path,
        context: 'load_pending',
        error: errMsg,
      });
    }
  }
}


/**
 * Recover tasks from filesystem on startup
 * - Pending tasks: load into queue
 * - Running tasks: move back to pending (they need to be re-executed)
 */
export async function recoverTasks(deps: RecoverTasksDeps): Promise<void> {
  const { auditWriter, pendingQueue } = deps;
  try {
    const recoveredFromRunning = await _recoverRunningTasks(deps);
    await _loadPendingTasks(deps);

    const failedEntries = await deps.fs.list(TASKS_QUEUES_FAILED_DIR).catch(() => []);
    const failedCount = failedEntries.filter(e => e.name.endsWith('.json')).length;

    emitRecoveryComplete(auditWriter, {
      pending: pendingQueue.length,
      recoveredRunning: recoveredFromRunning,
      failed: failedCount,
    });
  } catch (err) {
    const errMsg = formatErr(err);
    emitRecoveryFailed(auditWriter, {
      source: 'system',
      context: 'recovery_top',
      error: errMsg,
    });
  }


}
