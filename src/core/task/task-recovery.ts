import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditWriter } from '../../foundation/audit/writer.js';
import type { SubAgentTask, ToolTask } from './system.js';
import { TASKS_PENDING_DIR, TASKS_RUNNING_DIR } from '../../types/paths.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';
import { sendFallbackError, sendResult } from './result-delivery.js';

/** M9: 闭包 ≥ 4 依赖 → deps interface */
export interface RecoveryDeps {
  fs: FileSystem;
  auditWriter: AuditWriter;
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
    const runningEntries = await fs.list(TASKS_RUNNING_DIR);
    for (const entry of runningEntries) {
      if (entry.name.endsWith('.json')) {
        try {
          const content = await fs.read(entry.path);
          const task = JSON.parse(content) as SubAgentTask | ToolTask;
          if (task.kind === 'tool') {
            // callback 已丢失，移动到 failed，不重新执行
            const failedPath = `tasks/failed/${task.id}.json`;
            await fs.move(entry.path, failedPath);
            auditWriter?.write(TASK_AUDIT_EVENTS.DISCARDED, task.id, 'kind=tool', 'reason=daemon_restarted');
            // 通知 parent，避免永久挂起
            await sendFallbackError(fs, auditWriter, task, 'daemon restarted, tool task discarded').catch((e) => {
              auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, task.id, 'context=sendFallbackError', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
            });
          } else {
            // subagent 任务：检测是否已写出结果
            const resultPath  = `tasks/results/${task.id}/result.txt`;
            const sentMarker  = `tasks/results/${task.id}/result.txt.sent`;
            // 先检查 .sent 标记（表示上次恢复已成功投递，只需清理）
            const alreadySent = await fs.exists(sentMarker);
            const resultExists = !alreadySent && await fs.exists(resultPath);

            if (alreadySent) {
              // 上次恢复已投递，仅清理 running/ 残留
              await fs.move(entry.path, `tasks/done/${task.id}.json`).catch(() => {
                fs.delete(entry.path).catch(() => {});
              });
              auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, 'reason=already_sent');
            } else if (resultExists) {
              // 结果已写出，补发 inbox；成功后写 .sent 标记防止重复投递
              const resultContent = await fs.read(resultPath);
              const resultSent = await sendResult(fs, auditWriter, task, resultContent, false)
                .then(() => true)
                .catch((e) => {
                  auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, task.id, 'context=resend_result_failed', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
                  // resend 失败降级：发 fallbackError，parent 知道任务状态
                  sendFallbackError(fs, auditWriter, task, 'Result resend failed after recovery').catch(() => {});
                  return false;
                });
              if (resultSent) {
                await fs.writeAtomic(sentMarker, '1').catch(() => {});
              }
              await fs.move(entry.path, `tasks/done/${task.id}.json`).catch(() => {
                fs.delete(entry.path).catch(() => {});
              });
              auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, 'reason=result_file_exists');
            } else {
              // 结果未写出：移回 pending 重新执行（原有逻辑）
              const pendingPath = `${TASKS_PENDING_DIR}/${task.id}.json`;
              await fs.move(entry.path, pendingPath);
              recoveredFromRunning++;
              auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERED, task.id, `kind=${task.kind}`, 'from=running', 'to=pending');
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, entry.path, 'context=recover_running', `error=${errMsg}`);
        }
      }
    }

    // Load pending tasks
    const pendingEntries = await fs.list(TASKS_PENDING_DIR);
    for (const entry of pendingEntries) {
      if (entry.name.endsWith('.json')) {
        try {
          const content = await fs.read(entry.path);
          const task = JSON.parse(content) as SubAgentTask | ToolTask;
          if (task.kind === 'tool') {
            // pending 里的 tool 任务同样 callback 已丢失，移动到 failed
            const failedPath = `tasks/failed/${task.id}.json`;
            await fs.move(entry.path, failedPath);
            auditWriter?.write(TASK_AUDIT_EVENTS.DISCARDED, task.id, 'kind=tool', 'reason=daemon_restarted');
            // 通知 parent，避免永久挂起
            await sendFallbackError(fs, auditWriter, task, 'daemon restarted, tool task discarded').catch((e) => {
              auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, task.id, 'context=sendFallbackError_pending', `error=${e instanceof Error ? e.message : JSON.stringify(e)}`);
            });
          } else {
            // subagent 文件保留在 pending/，由 _initialScanPending 统一入队
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, entry.path, 'context=load_pending', `error=${errMsg}`);
        }
      }
    }

    // 统计历史失败任务数（仅用于审计，不重新执行）
    const failedEntries = await fs.list('tasks/failed').catch(() => []);
    const failedCount = failedEntries.filter(e => e.name.endsWith('.json')).length;

    auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_COMPLETE, 'system', `pending=${pendingQueue.length}`, `recovered_running=${recoveredFromRunning}`, `failed=${failedCount}`);

    // _initialScanPending 已迁至 startDispatch（避免在 initialize 期间触发 _dispatch）
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    auditWriter?.write(TASK_AUDIT_EVENTS.RECOVERY_FAILED, 'system', 'context=recovery_top', `error=${errMsg}`);
  }
}
