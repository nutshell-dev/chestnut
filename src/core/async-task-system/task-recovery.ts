import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { SubAgentTask, ToolTask, FullTaskId } from './types.js';
import { taskShortId } from './types.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from './dirs.js';
import { formatErr } from './_helpers.js';
import {
  emitRecovered,
  emitRecoveryComplete,
  emitRecoveryFailed,
  emitRecoveryDeadLetter,
} from './audit-emit.js';

import { validateTaskShape, backupCorruptTask } from './task-corrupt-helpers.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { isAlive, getProcessStartTime } from '../../foundation/process-exec/index.js';
import { sendFallbackError, sendResult, sendToolResult, SENT_MARKER } from './result-delivery.js';
import type { TaskId } from './types.js';


const RETRY_COUNT_PATH = (taskId: TaskId) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.retry-count`;
/**
 * Task recovery 最大重试次数 — 防 startup recovery 路径无限循环.
 * Derivation: 3 = 1 initial + 2 retry / 平衡 fast-fail vs transient fs error 容忍;
 * 与 DEFAULT_VERIFICATION_ATTEMPTS (3) 同型经验值.
 */
const MAX_RECOVERY_RETRIES = 3;
// SENT_MARKER 迁 result-delivery.ts（写者归属 / phase 789）

/** M9: 闭包 ≥ 4 依赖 → deps interface */
export interface RecoverTasksDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
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
  // Phase 875: terminalState outranks mode; a migrated task may already be done/failed.
  const ts = (task as unknown as Record<string, unknown>).terminalState as string | undefined;
  if (ts === 'done') {
    await deps.fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)
      .then(() => {
        emitRecovered(deps.auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          kind: task.kind,
          from: 'running',
          to: 'done',
          reason: 'terminal_state_done',
        });
      })
      .catch(async (e) => {
        emitRecoveryFailed(deps.auditWriter, {
          taskId: task.id,
          context: 'tool_done_move_failed',
          error: formatErr(e),
        });
      });
    return 0;
  }
  if (ts === 'failed') {
    await deps.fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
      .then(() => {
        emitRecovered(deps.auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          kind: task.kind,
          from: 'running',
          to: 'failed',
          reason: 'terminal_state_failed',
        });
      })
      .catch(async (e) => {
        emitRecoveryFailed(deps.auditWriter, {
          taskId: task.id,
          context: 'tool_failed_move_failed',
          error: formatErr(e),
        });
      });
    return 0;
  }

  if (task.mode === 'migrated' && task.migratedPid !== undefined) {
    return _recoverMigratedToolTask(deps, filePath, task);
  }

  // No terminalState: fresh task — re-execute only if idempotent
  if (task.isIdempotent) {
    const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
    await deps.fs.move(filePath, pendingPath);
    emitRecovered(deps.auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      kind: task.kind,
      from: 'running',
      to: 'pending',
    });
    return 1;
  }

  // Non-idempotent: don't re-execute — move to failed/manual-recovery
  await deps.fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
    .then(() => {
      emitRecovered(deps.auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        kind: task.kind,
        from: 'running',
        to: 'failed',
        reason: 'non_idempotent_recovery',
      });
    })
    .catch(async (e) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'non_idempotent_failed_move_failed',
        error: formatErr(e),
      });
    });
  return 0;
}

async function _recoverMigratedToolTask(
  deps: RecoverTasksDeps, filePath: string, task: ToolTask,
): Promise<number> {
  const { fs, auditWriter } = deps;
  const pid = task.migratedPid!;

  // 1. Check whether the migrated process is still alive.
  let processAlive = isAlive(pid);
  if (processAlive && task.migratedStartTime !== undefined) {
    const actualStartTime = getProcessStartTime(pid);
    if (actualStartTime !== undefined && actualStartTime !== task.migratedStartTime) {
      processAlive = false; // PID reused by a different process.
    }
  }

  if (processAlive) {
    // Cannot reconstruct the monitor (ChildProcess reference is lost across
    // restarts), but leave the task in running/ so we do not spawn a duplicate.
    // The process will eventually exit or be killed by the hard timeout.
    emitRecovered(auditWriter, {
      fullTaskId: task.id as FullTaskId,
      shortTaskId: taskShortId(task),
      kind: task.kind,
      from: 'running',
      to: 'running',
      reason: 'migrated_process_still_alive',
    });
    return 0;
  }

  // 2. Process is dead — check whether the wrapper already wrote the result.
  const resultPath = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt`;
  const resultExists = await fs.exists(resultPath).catch(() => false);

  if (resultExists) {
    const resultContent = await fs.read(resultPath).catch(() => '(output unavailable)');
    const sent = await sendToolResult(fs, auditWriter, task, resultContent, false)
      .then(() => true)
      .catch(() => false);

    if (sent) {
      await fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)
        .then(() => {
          emitRecovered(auditWriter, {
            fullTaskId: task.id as FullTaskId,
            shortTaskId: taskShortId(task),
            kind: task.kind,
            from: 'running',
            to: 'done',
            reason: 'migrated_result_delivered',
          });
        })
        .catch(async (e) => {
          emitRecoveryFailed(auditWriter, {
            taskId: task.id,
            context: 'migrated_done_move_failed',
            error: formatErr(e),
          });
          // Keep running file — sent marker ensures idempotency on next recovery.
        });
      return 0;
    }

    // Delivery failed: leave in running/ and retry on next startup.
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'migrated_result_delivery_failed',
    });
    return 0;
  }

  // 3. Process is dead and no result exists: output is unrecoverable.
  await fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
    .then(() => {
      emitRecovered(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        kind: task.kind,
        from: 'running',
        to: 'failed',
        reason: 'migrated_process_dead_no_result',
      });
    })
    .catch(async (e) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_failed_move_failed',
        error: formatErr(e),
      });
      // Keep running file — recovery will retry the move on next startup.
    });
  return 0;
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

async function _recoverToDone(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, reason: string,
  moveFailedContext: string,
): Promise<void> {
  await deps.fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)
    .then(async () => {
      // C.3 (phase 989): mirror _recoverWithResult line 166 cleanup / D5 hygiene / retry-count file 不 accumulate
      // phase 18: narrow ENOENT silent + 其他 IO error audit emit (Design Principle 不可预期失败暴露而非吞没)
      await deps.fs.delete(RETRY_COUNT_PATH(task.id)).catch((err) => {
        if (!isFileNotFound(err)) {
          emitRecoveryFailed(deps.auditWriter, {
            taskId: task.id,
            context: 'retry_counter_cleanup_failed',
            error: formatErr(err),
          });
        }
        // silent: ENOENT/FS_NOT_FOUND first-time recovery、retry-count file 未生成、cleanup 无目标
      });
      emitRecovered(deps.auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        reason,
      });
    })
    .catch(async (moveErr) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: moveFailedContext,
        error: formatErr(moveErr),
      });
      // Keep running file — sent marker ensures idempotency on next recovery.
    });
}

async function _recoverToFailed(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, reason: string,
  moveFailedContext: string,
): Promise<void> {
  await deps.fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
    .then(async () => {
      // C.3 (phase 989): mirror _recoverWithResult line 166 cleanup / D5 hygiene / retry-count file 不 accumulate
      await deps.fs.delete(RETRY_COUNT_PATH(task.id)).catch((err) => {
        if (!isFileNotFound(err)) {
          emitRecoveryFailed(deps.auditWriter, {
            taskId: task.id,
            context: 'retry_counter_cleanup_failed',
            error: formatErr(err),
          });
        }
        // silent: ENOENT/FS_NOT_FOUND first-time recovery、retry-count file 未生成、cleanup 无目标
      });
      emitRecovered(deps.auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        reason,
      });
    })
    .catch(async (moveErr) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: moveFailedContext,
        error: formatErr(moveErr),
      });
      // Keep running file — terminalState ensures correct routing on next recovery.
    });
}

async function _recoverAlreadySent(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask,
): Promise<void> {
  const terminalState = ((task as unknown) as Record<string, unknown>).terminalState as string | undefined;
  if (terminalState === 'failed') {
    await _recoverToFailed(deps, filePath, task, 'terminal_state_failed', 'terminal_state_failed_move_failed');
  } else {
    // 'done', undefined (backward compat), or any other value → done
    await _recoverToDone(deps, filePath, task, terminalState === 'done' ? 'terminal_state_done' : 'already_sent', 'alreadysent_move_failed');
  }
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
        raw: auditWriter.preview(raw),
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
    // phase 18: narrow ENOENT silent + 其他 IO error audit emit (Design Principle 不可预期失败暴露而非吞没)
    await fs.delete(retryPath).catch((err) => {
      if (!isFileNotFound(err)) {
        emitRecoveryFailed(auditWriter, {
          taskId: task.id,
          context: 'retry_counter_cleanup_failed',
          error: formatErr(err),
        });
      }
      // silent: ENOENT/FS_NOT_FOUND first-time recovery、retry-count file 未生成、cleanup 无目标
    });
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
  await fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)
    .then(() => {
      emitRecovered(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        reason: 'result_file_exists',
      });
    })
    .catch(async (moveErr) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'done_move_failed',
        error: formatErr(moveErr),
      });
      // Keep running file — result.txt.sent marker ensures idempotency on next recovery.
    });
  return 0;
}

async function _moveToDeadLetter(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, retryCount: number, retryPath: string,
): Promise<void> {
  const { fs, auditWriter } = deps;
  await fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
    .then(async () => {
      // Phase 874: only cleanup retry counter on successful move
      await fs.delete(retryPath).catch((cleanupErr) => {
        if (!isFileNotFound(cleanupErr)) {
          emitRecoveryFailed(auditWriter, {
            taskId: task.id,
            context: 'dead_letter_retrypath_cleanup_failed',
            error: formatErr(cleanupErr),
          });
        }
        // silent: ENOENT/FS_NOT_FOUND — retry counter already absent; cleanup has no target
      });
      // Phase 875: only emit dead-letter audit after the move succeeds.
      emitRecoveryDeadLetter(auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        retries: retryCount,
      });
    })
    .catch(async (moveErr) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'dead_letter_move_failed',
        error: formatErr(moveErr),
      });
      // Keep running file + retry counter for next recovery attempt.
    });
}

async function _recoverWithoutResult(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask,
): Promise<number> {
  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
  await deps.fs.move(filePath, pendingPath)
    .then(() => {
      emitRecovered(deps.auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        kind: task.kind,
        from: 'running',
        to: 'pending',
      });
    })
    .catch(async (moveErr) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'without_result_move_failed',
        error: formatErr(moveErr),
      });
      // Keep running file — next recovery will retry the move back to pending.
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
  const { auditWriter } = deps;
  try {
    const recoveredFromRunning = await _recoverRunningTasks(deps);
    await _loadPendingTasks(deps);

    const pendingEntries = await deps.fs.list(TASKS_QUEUES_PENDING_DIR).catch(() => []);
    const pendingCount = pendingEntries.filter(e => e.name.endsWith('.json')).length;
    const failedEntries = await deps.fs.list(TASKS_QUEUES_FAILED_DIR).catch(() => []);
    const failedCount = failedEntries.filter(e => e.name.endsWith('.json')).length;

    emitRecoveryComplete(auditWriter, {
      pending: pendingCount,
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
