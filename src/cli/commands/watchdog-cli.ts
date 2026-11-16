/**
 * @module L6.CLI.WatchdogCli
 * Watchdog CLI subcommands — start + stop
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  type WatchdogProcessDeps,
  createWatchdogActionAudit,
  getWatchdogPid, inspectWatchdogLivenessForCli, removeWatchdogPid, WatchdogPidForeignWorkspaceError,
  stopWatchdog,
  WATCHDOG_AUDIT_EVENTS,
  WATCHDOG_LOG_HINT,
  spawnWatchdogCandidate,
  WatchdogCandidateAdmissionRejectedError,
} from '../../watchdog/index.js';
import { CliError } from '../errors.js';
import { requireMotionAccess } from '../../core/claw-topology/index.js';
import { getCapturedCliMotionAccess } from '../motion-cli-guard.js';

/** Spawn watchdog candidate + CLI 外壳（console 输出 + CliError 错误格式）。
 *  核心 spawn + poll 委托 spawnWatchdogCandidate（watchdog/spawn.ts）。 */
export async function startCommand(
  fsFactory: (baseDir: string) => FileSystem,
  _deps?: WatchdogProcessDeps,
): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('start'), 'start', 'watchdog/start');
  // 幂等：本 workspace 的 watchdog 已在运行则直接返回
  try {
    if (inspectWatchdogLivenessForCli(fsFactory, _deps) === 'alive') {
      console.log(`Watchdog already running (PID: ${getWatchdogPid(fsFactory)})`);
      return;
    }
  } catch (err) {
    if (err instanceof WatchdogPidForeignWorkspaceError) {
      throw new CliError(
        `Watchdog already running for foreign workspace.\n` +
        `  PID:   ${err.foreignPid}\n` +
        `  Root:  ${err.foreignRoot}\n\n` +
        `Run "chestnut stop" in that workspace.`
      );
    }
    throw err;
  }

  try {
    const pid = await spawnWatchdogCandidate(fsFactory);
    console.log(`Watchdog started (PID: ${pid})`);
  } catch (err) {
    if (err instanceof WatchdogCandidateAdmissionRejectedError) {
      throw new CliError(
        `Watchdog candidate admission rejected (${err.reason}). ` +
        `Recovery window: ${err.windowId}; attempt: ${err.attemptId}.`,
        1,
      );
    }
    throw new CliError(
      // Phase 1878 Step K: 同 spawn.ts——指向 Watchdog owner 日志面（watchdog-log 单源提示）
      `Watchdog failed to start within 3s. Check watchdog log at ${WATCHDOG_LOG_HINT}.`,
      1,
    );
  }
}

/** Stop watchdog daemon. */
export async function stopCommand(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): Promise<void> {
  requireMotionAccess(getCapturedCliMotionAccess('stop'), 'stop', 'watchdog/stop');
  // Phase 1878 Step I: writer 生命周期归 action——stop-all / wrapper 已安装则复用
  // （非 owner handle），未安装则本调用 scoped own + 终态 dispose（不悬挂）。
  const actionAudit = createWatchdogActionAudit(fsFactory);
  try {
    await stopCommandWithAudit(fsFactory, actionAudit.audit, deps);
  } finally {
    actionAudit.dispose();
  }
}

async function stopCommandWithAudit(
  fsFactory: (baseDir: string) => FileSystem,
  audit: AuditLog | null,
  deps?: WatchdogProcessDeps,
): Promise<void> {
  const outcome = await stopWatchdog(fsFactory, deps);
  if (outcome.kind === 'not_running') {
    console.log('Watchdog is not running');
    removeWatchdogPid(fsFactory);
    console.log('Watchdog stopped');
    return;
  }
  if (outcome.kind === 'stopped') {
    // Active generation retirement remains owner-guarded; only legacy input is cleaned.
    removeWatchdogPid(fsFactory);
    console.log('Watchdog stopped');
    return;
  }

  const pid = outcome.pid;
  if (outcome.kind === 'still_alive') {
    console.error('Watchdog still alive after SIGKILL');
    audit?.write(
      WATCHDOG_AUDIT_EVENTS.STOP_CONFIRM_FAILED,
      `pid=${pid}`,
      'stage=confirm',
      `evidence=${JSON.stringify(outcome.outcome.evidence)}`,
    );
    throw new CliError(`Watchdog stop was not confirmed (PID: ${pid})`, 1);
  }

  const error = outcome.error;
  if (outcome.stage === 'sigterm') {
    console.log('Failed to send SIGTERM:', error);
    audit?.write(
      WATCHDOG_AUDIT_EVENTS.STOP_SIGTERM_FAILED,
      `pid=${pid ?? 'unknown'}`,
      `error=${formatErr(error)}`,
    );
  } else if (outcome.stage === 'sigkill') {
    console.log('Failed to send SIGKILL:', error);
    audit?.write(
      WATCHDOG_AUDIT_EVENTS.STOP_SIGKILL_FAILED,
      `pid=${pid ?? 'unknown'}`,
      `error=${formatErr(error)}`,
    );
  } else {
    console.error('Watchdog stop could not be confirmed:', error);
    audit?.write(
      WATCHDOG_AUDIT_EVENTS.STOP_CONFIRM_FAILED,
      `pid=${pid ?? 'unknown'}`,
      `stage=${outcome.stage}`,
      `error=${formatErr(error)}`,
      ...(outcome.outcome ? [`evidence=${JSON.stringify(outcome.outcome.evidence)}`] : []),
    );
  }
  throw new CliError(
    `Watchdog stop was not confirmed${pid === undefined ? '' : ` (PID: ${pid})`}: ${formatErr(error)}`,
    1,
  );
}
