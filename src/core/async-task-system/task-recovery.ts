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
import { ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS } from './async-exec-wrapper.js';
import {
  emitRecovered,
  emitRecoveryComplete,
  emitRecoveryFailed,
  emitRecoveryDeadLetter,
  emitMigratedExecTermination,
  emitMigratedLegacyIdentity,
} from './audit-emit.js';
import { TASK_AUDIT_EVENTS } from './audit-events.js';

import { validateTaskShape, backupCorruptTask } from './task-corrupt-helpers.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import {
  probeExecutionGroup,
  terminateExecutionGroup,
  probeLegacyProcess,
  terminateLegacyProcess,
} from '../../foundation/process-exec/index.js';
import type { ExecutionIdentity } from '../../foundation/process-exec/index.js';
import {
  SENT_MARKER,
  sendResult as defaultSendResult,
  sendFallbackError as defaultSendFallbackError,
  sendToolResult as defaultSendToolResult,
} from './result-delivery.js';
import type { SendResult, SendFallbackError, SendToolResult, WriteInboxAsync, ResultDeliveryDeps } from './result-delivery-types.js';
import type { ProcessedTaskResult } from './result-delivery-types.js';
import { POST_PROCESS_INPUT_FILE, RESULT_META_FILE } from './dirs.js';
import { applyPostProcessor, commitFinalEnvelope } from './subagent-executor.js';
import type { TaskId } from './types.js';


const RETRY_COUNT_PATH = (taskId: TaskId) =>
  `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt.retry-count`;

async function loadCommittedEnvelope(
  fs: FileSystem,
  taskId: TaskId,
  resultContent: string,
): Promise<ProcessedTaskResult> {
  const metaPath = `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_META_FILE}`;
  try {
    const raw = await fs.read(metaPath);
    const meta = JSON.parse(raw) as { schema_version: number; is_error: boolean; metadata?: Record<string, string> };
    if (meta.schema_version === 1) {
      return { schema_version: 1, content: resultContent, isError: meta.is_error, metadata: meta.metadata };
    }
  } catch {
    // silent: missing or unreadable meta is expected; fall back to legacy classification.
  }
  return { schema_version: 1, content: resultContent, isError: false };
}
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
  sendResult?: SendResult<SubAgentTask>;
  sendFallbackError?: SendFallbackError<SubAgentTask | ToolTask>;
  sendToolResult?: SendToolResult<ToolTask>;
  writeInboxAsync?: WriteInboxAsync;
  postProcessors?: Map<string, import('./post-processors/types.js').PostProcessor>;
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
  const sendFallbackError = deps.sendFallbackError ?? defaultSendFallbackError;
  const resultDeliveryDeps: ResultDeliveryDeps = { writeInboxAsync: deps.writeInboxAsync };
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

  if (task.mode === 'migrated' && (task.migratedExecution !== undefined || task.migratedPid !== undefined)) {
    return recoverMigratedToolTask(deps, filePath, task);
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
  const notifiedPath = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt.notified`;
  let alreadyNotified = false;
  try {
    alreadyNotified = await deps.fs.exists(notifiedPath);
  } catch (e) {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'non_idempotent_marker_read_failed',
      error: formatErr(e),
    });
    // Can't determine state — stop, keep in running, retry next recovery
    return 0;
  }

  if (alreadyNotified) {
    // Notification already sent — just move to failed, don't re-notify
    await deps.fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
      .then(() => {
        emitRecovered(deps.auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          kind: task.kind,
          from: 'running',
          to: 'failed',
          reason: 'non_idempotent_already_notified',
        });
      })
      .catch(async (e) => {
        emitRecoveryFailed(deps.auditWriter, {
          taskId: task.id,
          context: 'non_idempotent_move_failed',
          error: formatErr(e),
        });
      });
    return 0;
  }

  // First time — send notification, then marker, then move
  await sendFallbackError(deps.fs, deps.auditWriter, task,
    'Non-idempotent tool task cannot be retried after crash. Manual intervention required.', true, resultDeliveryDeps)
    .then(async () => {
      // Persist notification-sent marker BEFORE moving to failed.
      // If crash occurs between marker and move, next recovery skips re-notification.
      try {
        await deps.fs.writeAtomic(notifiedPath, '');
      } catch (e) {
        emitRecoveryFailed(deps.auditWriter, {
          taskId: task.id,
          context: 'non_idempotent_marker_write_failed',
          error: formatErr(e),
        });
        // Don't move — keep in running for next recovery retry
        return;
      }

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
            context: 'non_idempotent_move_failed',
            error: formatErr(e),
          });
        });
    })
    .catch(async (e) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'non_idempotent_notify_failed',
        error: formatErr(e),
      });
      // Task stays in running — next recovery will retry
    });
  return 0;
}
/**
 * Deliver a one-shot manual-intervention notification for an indeterminate
 * task past its hard deadline, guarded by a persistent marker so restart
 * recovery never re-notifies (same idempotency pattern as result.txt.sent).
 * Returns true when the notification was delivered (or had already been
 * delivered); false keeps the task in running/ for a retry.
 */
async function notifyManualIntervention(
  deps: RecoverTasksDeps,
  task: ToolTask,
  reason: string,
): Promise<boolean> {
  const { fs, auditWriter } = deps;
  const sendFallbackError = deps.sendFallbackError ?? defaultSendFallbackError;
  const resultDeliveryDeps: ResultDeliveryDeps = { writeInboxAsync: deps.writeInboxAsync };
  const manualPath = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt.manual-intervention`;
  let alreadyNotified = false;
  try {
    alreadyNotified = await fs.exists(manualPath);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'migrated_manual_marker_read_failed',
      error: formatErr(err),
    });
    return false;
  }
  if (alreadyNotified) return true;
  const sent = await sendFallbackError(
    fs,
    auditWriter,
    task,
    `Migrated process ownership cannot be verified (${reason}) after the hard deadline. Manual intervention required.`,
    true,
    resultDeliveryDeps,
  )
    .then(() => true)
    .catch((e) => {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_manual_notify_failed',
        error: formatErr(e),
      });
      return false;
    });
  if (!sent) return false;
  try {
    await fs.writeAtomic(manualPath, '1');
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'migrated_manual_marker_write_failed',
      error: formatErr(err),
    });
  }
  return true;
}

/**
 * Move a manually-interventioned task to failed/. Move failure keeps the
 * running file; the marker guarantees the next recovery only retries the
 * move, never re-notifies.
 */
async function moveToFailedAfterManualIntervention(
  deps: RecoverTasksDeps,
  filePath: string,
  task: ToolTask,
): Promise<void> {
  await deps.fs.move(filePath, `${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)
    .then(() => {
      emitRecovered(deps.auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        kind: task.kind,
        from: 'running',
        to: 'failed',
        reason: 'migrated_manual_intervention',
      });
    })
    .catch(async (e) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'migrated_manual_move_failed',
        error: formatErr(e),
      });
    });
}

export async function recoverMigratedToolTask(
  deps: RecoverTasksDeps, filePath: string, task: ToolTask,
): Promise<number> {
  const { fs, auditWriter } = deps;
  const sendToolResult = deps.sendToolResult ?? defaultSendToolResult;
  const sendFallbackError = deps.sendFallbackError ?? defaultSendFallbackError;
  const resultDeliveryDeps: ResultDeliveryDeps = { writeInboxAsync: deps.writeInboxAsync };
  const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
  let killedByRecovery = false;
  let pidForAudit: number;

  // 1. Probe the migrated execution unit (phase 1269 Step E).
  //    All OS probes and signals go through L1; L4 maps the three-state
  //    result to task state. Safety rule: `indeterminate` means ownership
  //    cannot be proven (possible PID/PGID reuse) — never signal, never move
  //    the task, never deliver a "cleaned up" result.
  if (task.migratedExecution !== undefined) {
    // ── v1 execution-group protocol ──────────────────────────────────────
    const identity: ExecutionIdentity = {
      leaderPid: task.migratedExecution.leaderPid,
      processGroupId: task.migratedExecution.processGroupId,
    };
    pidForAudit = identity.leaderPid;
    const probe = probeExecutionGroup(identity, task.migratedExecution.leaderStartTime);

    if (probe.kind === 'indeterminate') {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_exec_probe_indeterminate',
        error: probe.reason,
      });
      const deadlineMs = task.migratedDeadlineMs ?? (Date.parse(task.createdAt) + ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS);
      if (Date.now() < deadlineMs) {
        return 0; // keep in running — deadline not reached, retry next cycle
      }
      // Hard deadline reached and ownership still unprovable: surface one
      // manual-intervention notification instead of silent indefinite
      // retention. Never signal, never guess — the task ends observably.
      if (!(await notifyManualIntervention(deps, task, probe.reason))) {
        return 0; // keep in running — retry notification next cycle
      }
      await moveToFailedAfterManualIntervention(deps, filePath, task);
      return 0;
    }

    if (probe.kind === 'verified_alive') {
      const deadlineMs = task.migratedDeadlineMs ?? (Date.parse(task.createdAt) + ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS);
      if (Date.now() < deadlineMs) {
        // Still within deadline, leave in running — natural convergence:
        // process will exit or hit deadline on next startup recovery scan.
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
      // Hard timeout exceeded — terminate the verified group via L1
      // (TERM→KILL→confirmed), then proceed only when provably gone.
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_process_hard_timeout_exceeded',
        error: `createdAt=${task.createdAt} deadlineMs=${deadlineMs}`,
      });
      const outcome = await terminateExecutionGroup(identity, 'caller_requested');
      emitMigratedExecTermination(auditWriter, {
        taskId: task.id,
        context: 'recovery_hard_timeout',
        identityCols: [
          `leader_pid=${identity.leaderPid}`,
          `process_group_id=${identity.processGroupId}`,
        ],
        trigger: outcome.trigger,
        termSent: outcome.termSent,
        killSent: outcome.killSent,
        status: outcome.status,
        reason: outcome.status === 'indeterminate' ? outcome.reason : undefined,
      });
      if (outcome.status !== 'gone') {
        return 0; // still_alive / indeterminate — keep in running, retry next cycle
      }
      killedByRecovery = true; // phase 1119: recovery itself killed the process
    }
    // probe.kind === 'gone' → fall through to result check
  } else {
    // ── legacy PID-only protocol (pre-phase-1269 writes) ─────────────────
    // The process was spawned non-detached and is NOT a group leader — never
    // guess a PGID. Verify and terminate THIS PROCESS ONLY via the explicit
    // L1 legacy path; descendant cleanup is unprovable and audited as such.
    const pid = task.migratedPid!;
    pidForAudit = pid;
    emitMigratedLegacyIdentity(auditWriter, { taskId: task.id, pid });

    const probe = probeLegacyProcess(pid, task.migratedStartTime);
    if (probe.kind === 'indeterminate') {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_legacy_probe_indeterminate',
        error: probe.reason,
      });
      const deadlineMs = task.migratedDeadlineMs ?? (Date.parse(task.createdAt) + ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS);
      if (Date.now() < deadlineMs) {
        return 0; // keep in running — deadline not reached, retry next cycle
      }
      // Hard deadline reached and ownership still unprovable: surface one
      // manual-intervention notification instead of silent indefinite
      // retention. Never signal, never guess — the task ends observably.
      if (!(await notifyManualIntervention(deps, task, probe.reason))) {
        return 0; // keep in running — retry notification next cycle
      }
      await moveToFailedAfterManualIntervention(deps, filePath, task);
      return 0;
    }

    if (probe.kind === 'alive') {
      const deadlineMs = task.migratedDeadlineMs ?? (Date.parse(task.createdAt) + ASYNC_EXEC_MIGRATED_HARD_TIMEOUT_MS);
      if (Date.now() < deadlineMs) {
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
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_process_hard_timeout_exceeded',
        error: `createdAt=${task.createdAt} deadlineMs=${deadlineMs}`,
      });
      const outcome = await terminateLegacyProcess(pid, task.migratedStartTime);
      emitMigratedExecTermination(auditWriter, {
        taskId: task.id,
        context: 'recovery_hard_timeout',
        identityCols: ['identity=legacy_pid_only', `leader_pid=${pid}`],
        trigger: 'caller_requested',
        termSent: outcome.termSent,
        killSent: outcome.killSent,
        status: outcome.status,
        reason: outcome.status === 'indeterminate' ? outcome.reason : undefined,
      });
      if (outcome.status !== 'gone') {
        return 0; // keep in running, retry next recovery cycle
      }
      killedByRecovery = true; // phase 1119: recovery itself killed the process
    }
    // probe.kind === 'gone' (dead or PID provably reused) → result check
  }

  // 2. Process is dead — check whether the wrapper already wrote the result.
  const resultPath = `${resultDir}/result.txt`;
  const sentMarkerPath = `${resultDir}/result.txt.sent`;

  // 0. If a previous recovery already delivered the result, just move to done.
  let alreadySent = false;
  try {
    alreadySent = await fs.exists(sentMarkerPath);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'migrated_sent_marker_read_failed',
      error: formatErr(err),
    });
    return 0;
  }

  if (alreadySent) {
    await fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)
      .then(() => {
        emitRecovered(auditWriter, {
          fullTaskId: task.id as FullTaskId,
          shortTaskId: taskShortId(task),
          kind: task.kind,
          from: 'running',
          to: 'done',
          reason: 'migrated_sent_marker_found',
        });
      })
      .catch(async (e) => {
        emitRecoveryFailed(auditWriter, {
          taskId: task.id,
          context: 'migrated_done_move_failed_after_sent',
          error: formatErr(e),
        });
        // Keep running file — sent marker ensures idempotency on next recovery.
      });
    return 0;
  }

  let resultExists: boolean;
  try {
    resultExists = await fs.exists(resultPath);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'migrated_result_exists_io_error',
      error: formatErr(err),
    });
    // I/O error: don't know whether the result exists — keep running for next recovery.
    return 0;
  }

  if (resultExists) {
    let resultContent: string;
    try {
      resultContent = await fs.read(resultPath);
    } catch (err) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_result_read_io_error',
        error: formatErr(err),
      });
      // I/O error: result exists but cannot be read — keep running for next recovery.
      return 0;
    }

    // phase 1119: determine whether the wrapper cleanly exited before daemon crash.
    let deliveredContent = resultContent;
    if (killedByRecovery) {
      deliveredContent += '\n[Process killed by recovery: hard timeout exceeded]';
    } else {
      const exitMarkerExists = await fs.exists(`${resultDir}/exit.json`).catch(() => false);
      if (!exitMarkerExists) {
        deliveredContent += '\n[Recovery note: daemon restarted while process was still running — output may be truncated]';
        auditWriter.write(
          TASK_AUDIT_EVENTS.MIGRATED_TRUNCATED_RESULT_DELIVERED,
          `taskId=${task.id}`,
          `pid=${pidForAudit}`,
        );
      }
    }

    const sent = await sendToolResult(fs, auditWriter, task, deliveredContent, false, resultDeliveryDeps)
      .then(() => true)
      .catch(() => false);

    if (sent) {
      // Persist sent marker BEFORE moving to done. If the move fails, the marker
      // guarantees the next recovery will skip re-delivery and only retry the move.
      try {
        await fs.writeAtomic(sentMarkerPath, '1');
      } catch (err) {
        emitRecoveryFailed(auditWriter, {
          taskId: task.id,
          context: 'migrated_sent_marker_persist_failed',
          error: formatErr(err),
        });
        return 0;
      }

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
  //    Marker-guarded like the result path: a move failure must never cause a
  //    duplicate notification on the next recovery pass.
  const fallbackMarkerPath = `${resultDir}/result.txt.manual`;
  let fallbackAlreadyNotified = false;
  try {
    fallbackAlreadyNotified = await fs.exists(fallbackMarkerPath);
  } catch (err) {
    emitRecoveryFailed(auditWriter, {
      taskId: task.id,
      context: 'migrated_fallback_marker_read_failed',
      error: formatErr(err),
    });
    return 0;
  }

  if (!fallbackAlreadyNotified) {
    const fallbackSent = await sendFallbackError(fs, auditWriter, task, 'Migrated process exited without producing output', true, resultDeliveryDeps)
      .then(() => true)
      .catch((e) => {
        emitRecoveryFailed(auditWriter, {
          taskId: task.id,
          context: 'migrated_fallback_error_failed',
          error: formatErr(e),
        });
        return false;
      });

    if (!fallbackSent) {
      // Keep in running — retry notification on next recovery
      return 0;
    }

    try {
      await fs.writeAtomic(fallbackMarkerPath, '1');
    } catch (err) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'migrated_fallback_marker_write_failed',
        error: formatErr(err),
      });
    }
  }

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
  const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
  const resultPath = `${resultDir}/result.txt`;
  const inputPath = `${resultDir}/${POST_PROCESS_INPUT_FILE}`;
  const sentMarker = SENT_MARKER(task.id);
  const alreadySent = await deps.fs.exists(sentMarker);
  const resultExists = !alreadySent && await deps.fs.exists(resultPath);
  const inputExists = !alreadySent && await deps.fs.exists(inputPath);

  if (alreadySent) {
    await _recoverAlreadySent(deps, filePath, task);
    return 0;
  } else if (resultExists) {
    // Phase 1396 Step J: committed result.txt (with optional result-meta.json).
    return await _recoverWithResult(deps, filePath, task, resultPath);
  } else if (inputExists) {
    // Phase 1396 Step J: durable input present but final envelope not committed;
    // replay the processor after registry is ready.
    return await _recoverWithInput(deps, filePath, task, inputPath);
  } else {
    return await _recoverWithoutResult(deps, filePath, task);
  }
}

async function _recoverWithInput(
  deps: RecoverTasksDeps, filePath: string, task: SubAgentTask, inputPath: string,
): Promise<number> {
  const sendResult = deps.sendResult ?? defaultSendResult;
  const resultDeliveryDeps: ResultDeliveryDeps = { writeInboxAsync: deps.writeInboxAsync };

  let raw: string;
  try {
    raw = await deps.fs.read(inputPath);
  } catch (err) {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'post_process_input_read_failed',
      error: formatErr(err),
    });
    return 0;
  }

  let input: { content: string; source_is_error: boolean };
  try {
    input = JSON.parse(raw) as { content: string; source_is_error: boolean };
  } catch (err) {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'post_process_input_corrupt',
      error: formatErr(err),
    });
    return 0;
  }

  try {
    const envelope = await applyPostProcessor(
      { content: input.content, sourceIsError: input.source_is_error },
      task,
      deps.postProcessors ?? new Map(),
      deps.fs,
      deps.auditWriter,
    );
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    await commitFinalEnvelope(deps.fs, resultDir, envelope);
    await sendResult(deps.fs, deps.auditWriter, task, envelope, resultDeliveryDeps);
  } catch (err) {
    emitRecoveryFailed(deps.auditWriter, {
      taskId: task.id,
      context: 'post_process_replay_failed',
      error: formatErr(err),
    });
    // Leave in running; next recovery will retry after the processor registry is ready.
    return 0;
  }

  await deps.fs.move(filePath, `${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)
    .then(() => {
      emitRecovered(deps.auditWriter, {
        fullTaskId: task.id as FullTaskId,
        shortTaskId: taskShortId(task),
        reason: 'post_process_input_replayed',
      });
    })
    .catch(async (moveErr) => {
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'replay_done_move_failed',
        error: formatErr(moveErr),
      });
    });
  return 0;
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
  const sendResult = deps.sendResult ?? defaultSendResult;
  const sendFallbackError = deps.sendFallbackError ?? defaultSendFallbackError;
  const resultDeliveryDeps: ResultDeliveryDeps = { writeInboxAsync: deps.writeInboxAsync };
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
      // Phase 889: non-ENOENT counter read failure must stop this recovery attempt.
      return 0;
    }
  }

  // counterCorrupt → force dead-letter promotion 防永循环 retry
  if (counterCorrupt) {
    retryCount = MAX_RECOVERY_RETRIES;
  }

  const resultContent = await fs.read(resultPath);
  const envelope = await loadCommittedEnvelope(fs, task.id, resultContent);
  const resultSent = await sendResult(fs, auditWriter, task, envelope, resultDeliveryDeps)
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
        await sendFallbackError(fs, auditWriter, task, envelope.content, envelope.isError, resultDeliveryDeps);
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
    try {
      await fs.writeAtomic(retryPath, String(retryCount));
    } catch (e) {
      emitRecoveryFailed(auditWriter, {
        taskId: task.id,
        context: 'retry_counter_persist_failed',
        error: formatErr(e),
      });
      // Phase 889: counter persist failure must stop this recovery attempt.
      return 0;
    }
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
  // phase 1119 P1-15: terminalState 分流（mirror _recoverAlreadySent）——
  // 已宣告终态的任务不得移回 pending 重执行。
  const terminalState = ((task as unknown) as Record<string, unknown>).terminalState as string | undefined;
  if (terminalState === 'failed') {
    await _recoverToFailed(deps, filePath, task, 'terminal_state_failed', 'without_result_failed_move_failed');
    return 0;
  }
  if (terminalState === 'done') {
    await _recoverToDone(deps, filePath, task, 'terminal_state_done', 'without_result_done_move_failed');
    return 0;
  }

  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${task.id}.json`;
  let recovered = 1;
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
      recovered = 0; // move failed — not recovered
      emitRecoveryFailed(deps.auditWriter, {
        taskId: task.id,
        context: 'without_result_move_failed',
        error: formatErr(moveErr),
      });
      // Keep running file — next recovery will retry the move back to pending.
    });
  return recovered;
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

    let pendingCount: number;
    try {
      const pendingEntries = await deps.fs.list(TASKS_QUEUES_PENDING_DIR);
      pendingCount = pendingEntries.filter(e => e.name.endsWith('.json')).length;
    } catch (e) {
      emitRecoveryFailed(auditWriter, {
        source: 'system',
        context: 'recovery_pending_list_failed',
        error: formatErr(e),
      });
      throw e;
    }

    let failedCount: number;
    try {
      const failedEntries = await deps.fs.list(TASKS_QUEUES_FAILED_DIR);
      failedCount = failedEntries.filter(e => e.name.endsWith('.json')).length;
    } catch (e) {
      emitRecoveryFailed(auditWriter, {
        source: 'system',
        context: 'recovery_failed_list_failed',
        error: formatErr(e),
      });
      throw e;
    }

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
    throw err; // Phase 877: recovery failure must prevent initialization
  }
}
