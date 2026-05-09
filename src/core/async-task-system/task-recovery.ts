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
import { formatErr, auditError } from './_helpers.js';
import { sendFallbackError, sendResult } from './result-delivery.js';

const RETRY_COUNT_PATH = (taskId: string) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.retry-count`;
const MAX_RECOVERY_RETRIES = 3;

/** M9: 闭包 ≥ 4 依赖 → deps interface */
export interface RecoveryDeps {
  fs: FileSystem;
  auditWriter: AuditLog;
  pendingQueue: Array<SubAgentTask | ToolTask>;
}

/**
 * Recover tasks from filesystem on startup
 * - Pending tasks: load into queue
 * - Running tasks: move back to pending (they need to be re-executed)
 */
export async function recoverTasks(deps: RecoveryDeps): Promise<void> {
  const { fs, auditWriter, pendingQueue } = deps;
  try {
    let recoveredFromRunning = 0;
    // First, move any running tasks back to pending (they were interrupted)
    const runningEntries = await fs.list(TASKS_QUEUES_RUNNING_DIR);
    for (const entry of runningEntries) {
      if (entry.name.endsWith('.json')) {
        try {
          const content = await fs.read(entry.path);
          const task = JSON.parse(content) as SubAgentTask | ToolTask;
          if (task.kind === 'tool') {
            // phase432: ToolTask 改为 fs-driven / args+parentClawDir 可恢复 / 移回 pending 重新执行
            const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
            await fs.move(entry.path, pendingPath);
            recoveredFromRunning++;
            auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, `kind=${task.kind}`, 'from=running', 'to=pending');
          } else {
            // subagent 任务：检测是否已写出结果
            const resultPath  = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt`;
            const sentMarker  = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt.sent`;
            // 先检查 .sent 标记（表示上次恢复已成功投递，只需清理）
            const alreadySent = await fs.exists(sentMarker);
            const resultExists = !alreadySent && await fs.exists(resultPath);

            if (alreadySent) {
              // 上次恢复已投递，仅清理 running/ 残留
              await fs.move(entry.path, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`).catch(async (moveErr) => {
                auditWriter.write(
                  TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                  task.id,
                  'context=alreadysent_move_failed',
                  `error=${formatErr(moveErr)}`,
                );
                // 降级：直接 delete 残留 / delete 也失败再 audit
                await fs.delete(entry.path).catch((delErr) => {
                  auditWriter.write(
                    TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                    task.id,
                    'context=alreadysent_delete_failed',
                    `error=${formatErr(delErr)}`,
                  );
                });
              });
              auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, 'reason=already_sent');
            } else if (resultExists) {
              // 读取 retry count
              let retryCount = 0;
              const retryPath = RETRY_COUNT_PATH(task.id);
              try {
                retryCount = parseInt(await fs.read(retryPath), 10) || 0;
              } catch { /* 首次无文件 */ }

              // 结果已写出，补发 inbox；成功后写 .sent 标记防止重复投递
              const resultContent = await fs.read(resultPath);
              const resultSent = await sendResult(fs, auditWriter, task, resultContent, false)
                .then(() => true)
                .catch((e) => {
                  auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, task.id, 'context=resend_result_failed', `error=${formatErr(e)}`);
                  // resend 失败降级：发 fallbackError，parent 知道任务状态
                  sendFallbackError(fs, auditWriter, task, 'Result resend failed after recovery').catch(() => {});
                  return false;
                });
              if (resultSent) {
                await fs.writeAtomic(sentMarker, '1').catch(() => {});
                // 清理 retry count
                await fs.delete(retryPath).catch(() => {});
              } else {
                // 累加 retry
                retryCount++;
                await fs.writeAtomic(retryPath, String(retryCount)).catch(() => {});
                if (retryCount >= MAX_RECOVERY_RETRIES) {
                  // dead-letter: 转 failed
                  auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER, task.id,
                    `retries=${retryCount}`, 'action=move_to_failed');
                  await fs.move(entry.path, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`).catch(async (moveErr) => {
                    auditWriter.write(
                      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                      task.id,
                      'context=dead_letter_move_failed',
                      `error=${formatErr(moveErr)}`,
                    );
                    await fs.delete(entry.path).catch((delErr) => {
                      auditWriter.write(
                        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                        task.id,
                        'context=dead_letter_delete_failed',
                        `error=${formatErr(delErr)}`,
                      );
                    });
                  });
                  // C2.a: cleanup retry counter file (best-effort with audit)
                  await fs.delete(retryPath).catch((cleanupErr) => {
                    auditWriter.write(
                      TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                      task.id,
                      'context=dead_letter_retrypath_cleanup_failed',
                      `error=${formatErr(cleanupErr)}`,
                    );
                  });
                  return; // 不走后续 move to done
                }
              }

              // 正常路径: move running → done
              await fs.move(entry.path, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`).catch(async (moveErr) => {
                auditWriter.write(
                  TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                  task.id,
                  'context=done_move_failed',
                  `error=${formatErr(moveErr)}`,
                );
                await fs.delete(entry.path).catch((delErr) => {
                  auditWriter.write(
                    TASK_AUDIT_EVENTS.RECOVERY_FAILED,
                    task.id,
                    'context=done_delete_failed',
                    `error=${formatErr(delErr)}`,
                  );
                });
              });
              auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, 'reason=result_file_exists');
            } else {
              // 结果未写出：移回 pending 重新执行（原有逻辑）
              const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
              await fs.move(entry.path, pendingPath);
              recoveredFromRunning++;
              auditWriter.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, `kind=${task.kind}`, 'from=running', 'to=pending');
            }
          }
        } catch (err) {
          const errMsg = formatErr(err);
          auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, entry.path, 'context=recover_running', `error=${errMsg}`);
        }
      }
    }

    // Load pending tasks
    const pendingEntries = await fs.list(TASKS_QUEUES_PENDING_DIR);
    for (const entry of pendingEntries) {
      if (entry.name.endsWith('.json')) {
        try {
          const content = await fs.read(entry.path);
          const task = JSON.parse(content) as SubAgentTask | ToolTask;
          if (task.kind === 'tool') {
            // phase432: ToolTask 保留在 pending/，由 _initialScanPending 统一入队
          } else {
            // subagent 文件保留在 pending/，由 _initialScanPending 统一入队
          }
        } catch (err) {
          const errMsg = formatErr(err);
          auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, entry.path, 'context=load_pending', `error=${errMsg}`);
        }
      }
    }

    // 统计历史失败任务数（仅用于审计，不重新执行）
    const failedEntries = await fs.list(TASKS_QUEUES_FAILED_DIR).catch(() => []);
    const failedCount = failedEntries.filter(e => e.name.endsWith('.json')).length;

    auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_COMPLETE, 'system', `pending=${pendingQueue.length}`, `recovered_running=${recoveredFromRunning}`, `failed=${failedCount}`);

    // _initialScanPending 已迁至 startDispatch（避免在 initialize 期间触发 _dispatch）
  } catch (err) {
    const errMsg = formatErr(err);
    auditWriter.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'system', 'context=recovery_top', `error=${errMsg}`);
  }

  // phase 515 / startup orphan subagent workspace cleanup
  // daemon 启动期无 in-flight subagent / tasks/subagents/ 内全 orphan / 全清安全
  try {
    const subagentDirs = await fs.list(TASKS_SUBAGENTS_DIR, { includeDirs: true }).catch(() => []);
    for (const entry of subagentDirs) {
      if (entry.isDirectory) {
        await fs.removeDir(`${TASKS_SUBAGENTS_DIR}/${entry.name}`).catch((err) => {
          auditWriter.write(
            TASK_AUDIT_EVENTS.SUBAGENT_WORKSPACE_CLEANUP_FAILED,
            'recovery',
            `dir=${TASKS_SUBAGENTS_DIR}/${entry.name}`,
            `error=${formatErr(err)}`,
          );
        });
      }
    }
  } catch (sweepErr) {
    // best-effort / 整体 sweep 失败也不阻 recovery
    auditWriter.write(
      TASK_AUDIT_EVENTS.SUBAGENT_WORKSPACE_CLEANUP_FAILED,
      'recovery_sweep',
      `error=${formatErr(sweepErr)}`,
    );
  }
}
