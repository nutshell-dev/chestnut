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
} from '../../types/paths.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from './_helpers.js';
import { FileNotFoundError } from '../../types/errors.js';
import { sendFallbackError, sendResult } from './result-delivery.js';

const RETRY_COUNT_PATH = (taskId: string) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.retry-count`;
const MAX_RECOVERY_RETRIES = 3;
const SENT_MARKER = (taskId: string) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.sent`;

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
      const task = JSON.parse(content) as SubAgentTask | ToolTask;
      if (task.kind === 'tool') {
        recoveredCount += await _recoverToolTask(deps, entry.path, task);
      } else {
        recoveredCount += await _recoverSubAgentTask(deps, entry.path, task);
      }
    } catch (err) {
      const errMsg = formatErr(err);
      auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, entry.path, 'context=recover_running', `error=${errMsg}`);
    }
  }
  return recoveredCount;
}

async function _recoverToolTask(
  deps: RecoverTasksDeps, filePath: string, task: ToolTask,
): Promise<number> {
  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
  await deps.fs.move(filePath, pendingPath);
  deps.auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, `kind=${task.kind}`, 'from=running', 'to=pending');
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
    deps.auditWriter.write(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      task.id,
      'context=alreadysent_move_failed',
      `error=${formatErr(moveErr)}`,
    );
    await deps.fs.delete(filePath).catch((delErr) => {
      deps.auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=alreadysent_delete_failed',
        `error=${formatErr(delErr)}`,
      );
    });
  });
  deps.auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, 'reason=already_sent');
}

async function _recoverWithResult(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, resultPath: string,
): Promise<number> {
  const { fs, auditWriter } = deps;
  const retryPath = RETRY_COUNT_PATH(task.id);

  let retryCount = 0;
  try {
    retryCount = parseInt(await fs.read(retryPath), 10) || 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // first-run / file 不存在 silent OK；其他 IO 错 audit（防 silent retry counter reset）
    if (code !== 'ENOENT' && !(err instanceof FileNotFoundError)) {
      auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=retry_counter_read_failed',
        `error=${formatErr(err)}`,
      );
    }
  }

  const resultContent = await fs.read(resultPath);
  const resultSent = await sendResult(fs, auditWriter, task, resultContent, false)
    .then(() => true)
    .catch((e) => {
      auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, task.id, 'context=resend_result_failed', `error=${formatErr(e)}`);
      sendFallbackError(fs, auditWriter, task, 'Result resend failed after recovery').catch(() => {});
      return false;
    });

  if (resultSent) {
    await fs.writeAtomic(SENT_MARKER(task.id), '1').catch((e) => {
      auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=sent_marker_persist_failed',
        `error=${formatErr(e)}`,
      );
    });
    // retryPath delete 失败无害（残文件下次 startup 覆盖 / 不影响 dead-letter promotion）
    await fs.delete(retryPath).catch(() => {});
  } else {
    retryCount++;
    await fs.writeAtomic(retryPath, String(retryCount)).catch((e) => {
      auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=retry_counter_persist_failed',
        `error=${formatErr(e)}`,
      );
    });
    if (retryCount >= MAX_RECOVERY_RETRIES) {
      await _moveToDeadLetter(deps, filePath, task, retryCount, retryPath);
      return 0;
    }
    // P1.8 fix (phase 612): retryCount<MAX 时不 move DONE / 保 running/ /
    // 下次启动 recovery 再 trigger _recoverWithResult / counter 持久化 / 累至 MAX → dead-letter
    // 之前 fall-through 到 line 130 move DONE 是 silent drop bug（resultSent=false 但移 DONE / parent 永不收 / 下次启动 0 retry）
    auditWriter.write(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      task.id,
      'context=retry_pending',
      `retryCount=${retryCount}`,
      `maxRetries=${MAX_RECOVERY_RETRIES}`,
    );
    return 0;
  }

  // 仅 success path 走这里 (resultSent=true)
  await fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`).catch(async (moveErr) => {
    auditWriter.write(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      task.id,
      'context=done_move_failed',
      `error=${formatErr(moveErr)}`,
    );
    await fs.delete(filePath).catch((delErr) => {
      auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=done_delete_failed',
        `error=${formatErr(delErr)}`,
      );
    });
  });
  auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, 'reason=result_file_exists');
  return 0;
}

async function _moveToDeadLetter(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, retryCount: number, retryPath: string,
): Promise<void> {
  const { fs, auditWriter } = deps;
  auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER, task.id,
    `retries=${retryCount}`, 'action=move_to_failed');
  await fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`).catch(async (moveErr) => {
    auditWriter.write(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      task.id,
      'context=dead_letter_move_failed',
      `error=${formatErr(moveErr)}`,
    );
    await fs.delete(filePath).catch((delErr) => {
      auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=dead_letter_delete_failed',
        `error=${formatErr(delErr)}`,
      );
    });
  });
  await fs.delete(retryPath).catch((cleanupErr) => {
    auditWriter.write(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      task.id,
      'context=dead_letter_retrypath_cleanup_failed',
      `error=${formatErr(cleanupErr)}`,
    );
  });
}

async function _recoverWithoutResult(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask,
): Promise<number> {
  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
  await deps.fs.move(filePath, pendingPath).catch(async (moveErr) => {
    deps.auditWriter.write(
      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
      task.id,
      'context=without_result_move_failed',
      `error=${formatErr(moveErr)}`,
    );
    await deps.fs.delete(filePath).catch((delErr) => {
      deps.auditWriter.write(
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        task.id,
        'context=without_result_delete_failed',
        `error=${formatErr(delErr)}`,
      );
    });
  });
  deps.auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, `kind=${task.kind}`, 'from=running', 'to=pending');
  return 1;
}

async function _loadPendingTasks(deps: RecoverTasksDeps): Promise<void> {
  const { fs, auditWriter } = deps;
  const pendingEntries = await fs.list(TASKS_QUEUES_PENDING_DIR);
  for (const entry of pendingEntries) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const content = await fs.read(entry.path);
      JSON.parse(content) as SubAgentTask | ToolTask;
      // 文件保留 / by _initialScanPending 入队
    } catch (err) {
      const errMsg = formatErr(err);
      auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, entry.path, 'context=load_pending', `error=${errMsg}`);
    }
  }
}

async function _cleanupOrphanSubagentWorkspaces(deps: RecoverTasksDeps): Promise<void> {
  const { fs, auditWriter } = deps;
  try {
    const subagentDirs = await fs.list(TASKS_SUBAGENTS_DIR, { includeDirs: true }).catch(() => []);
    for (const entry of subagentDirs) {
      if (!entry.isDirectory) continue;
      await fs.removeDir(`${TASKS_SUBAGENTS_DIR}/${entry.name}`).catch((err) => {
        auditWriter.write(
          TASK_AUDIT_EVENTS.SUBAGENT_WORKSPACE_CLEANUP_FAILED,
          'recovery',
          `dir=${TASKS_SUBAGENTS_DIR}/${entry.name}`,
          `error=${formatErr(err)}`,
        );
      });
    }
  } catch (sweepErr) {
    auditWriter.write(
      TASK_AUDIT_EVENTS.SUBAGENT_WORKSPACE_CLEANUP_FAILED,
      'recovery_sweep',
      `error=${formatErr(sweepErr)}`,
    );
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

    auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_COMPLETE, 'system', `pending=${pendingQueue.length}`, `recovered_running=${recoveredFromRunning}`, `failed=${failedCount}`);
  } catch (err) {
    const errMsg = formatErr(err);
    auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'system', 'context=recovery_top', `error=${errMsg}`);
  }

  // startup orphan subagent workspace cleanup
  await _cleanupOrphanSubagentWorkspaces(deps);
}
