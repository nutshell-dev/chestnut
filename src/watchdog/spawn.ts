/**
 * @module L6.Watchdog.Spawn
 * Watchdog daemon spawn 原语：spawnDetached + poll 等待 active owner 出现。
 *
 * 不含 CLI 关注点（console.log / CliError / audit）。CLI 外壳在 cli/commands/watchdog-cli.ts。
 */
import { setTimeout } from 'timers/promises';
import { spawnDetached } from '../foundation/process-exec/index.js';
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import * as path from 'path';
import { getWatchdogEntryPath } from './watchdog-context.js';
import {
  assertWatchdogOwnerWorkspace,
  inspectWatchdogOwner,
  WatchdogOwnerInspectionError,
} from './watchdog-pid.js';
import {
  prepareWatchdogProcessOutput,
  writeWatchdogRawFallback,
  WATCHDOG_LOG_HINT,
} from './watchdog-log.js';
import type { FileSystem } from '../foundation/fs/index.js';
import {
  admitWatchdogCandidate,
  WATCHDOG_CANDIDATE_ATTEMPT_ENV,
} from './candidate-recovery.js';
import { getChestnutFs } from './watchdog-context.js';
import {
  inspectTerminalForAttempt,
  writeCandidateOutcome,
  type WatchdogAttemptTerminalInspection,
  type WatchdogGenerationTerminal,
} from './watchdog-ownership.js';
import { formatErr } from '../foundation/node-utils/index.js';

/**
 * spawn 后 poll alive 的间隔（ms）。
 * Derivation: 100ms — 1:1 保原 watchdog-cli.ts WATCHDOG_POLL_INTERVAL_MS。
 */
const WATCHDOG_POLL_INTERVAL_MS = 100;

/**
 * poll alive 最大次数。
 * Derivation: 100ms × 30 = 3s — 1:1 保原 watchdog-cli.ts WATCHDOG_START_MAX_ATTEMPTS。
 */
const WATCHDOG_START_MAX_ATTEMPTS = 30;

function recordSpawnFailureBestEffort(
  fsFactory: (baseDir: string) => FileSystem,
  attemptId: string,
  error: unknown,
): void {
  try {
    writeCandidateOutcome(getChestnutFs(fsFactory), attemptId, {
      outcome: 'failed',
      reason: `caller_spawn_failed:${formatErr(error)}`,
    });
  } catch { // silent: preserve the original spawn failure and existing child outcome
  }
}

export class WatchdogCandidateAdmissionRejectedError extends Error {
  constructor(
    readonly reason: 'budget_exhausted' | 'window_closed',
    readonly attemptId: string,
    readonly windowId: string,
  ) {
    super(`Watchdog candidate admission rejected (${reason}): window=${windowId} attempt=${attemptId}`);
    this.name = 'WatchdogCandidateAdmissionRejectedError';
  }
}

export class WatchdogStartupCrashError extends Error {
  constructor(
    summary: string,
    readonly terminal: Extract<WatchdogGenerationTerminal, { kind: 'crashed' }>,
  ) {
    super(`Watchdog crashed during startup: ${summary}. Check watchdog log at ${WATCHDOG_LOG_HINT}.`);
    this.name = 'WatchdogStartupCrashError';
  }
}

export class WatchdogStartupUnconfirmedError extends Error {
  constructor(
    readonly evidence: Extract<WatchdogAttemptTerminalInspection, { kind: 'unknown' }>,
  ) {
    super(
      `Watchdog startup outcome is unconfirmed (${evidence.reason}). ` +
      `Check watchdog log at ${WATCHDOG_LOG_HINT}.`,
    );
    this.name = 'WatchdogStartupUnconfirmedError';
  }
}

function inspectAliveWinner(fsFactory: (baseDir: string) => FileSystem): number | null {
  const inspection = inspectWatchdogOwner(fsFactory);
  if (inspection.kind === 'unknown' || inspection.kind === 'malformed') {
    throw new WatchdogOwnerInspectionError(inspection);
  }
  if (inspection.kind !== 'none') assertWatchdogOwnerWorkspace(inspection);
  return inspection.kind === 'alive' ? inspection.pid : null;
}

/**
 * Spawn watchdog daemon candidate 并 poll 等待 active owner 出现。
 *
 * 不保证返回的 pid 是自己的 child（per-contender 语义下并发 caller 可能 spawn
 * 多个 candidate，只有一个 commit directory ownership 胜出）。
 *
 * @returns 当前 active owner 的 pid
 * @throws Error 如果 spawn 后超时仍无 alive watchdog
 */
export async function spawnWatchdogCandidate(
  fsFactory: (baseDir: string) => FileSystem,
  admittedAttemptId?: string,
): Promise<number> {
  const watchdogEntryPath = getWatchdogEntryPath();
  let attemptId = admittedAttemptId;
  if (!attemptId) {
    // Compatibility surface (including watchdog CLI start) must not bypass the
    // same durable budget used by ensureWatchdog.
    const admission = admitWatchdogCandidate(getChestnutFs(fsFactory), null);
    if (admission.kind === 'rejected') {
      throw new WatchdogCandidateAdmissionRejectedError(
        admission.reason,
        admission.attemptId,
        admission.windowId,
      );
    }
    attemptId = admission.admission.attemptId;
  }
  // Phase 1930 Step B：child CHESTNUT_ROOT env 与 cwd 保持既有父目录协议，
  // 由实例根私有推导（与 daemon spawn-options 同一约定）。
  const legacyParent = path.dirname(getChestnutRoot());
  // phase 1763: 提交点前失败经 typed outcome 抛出（含原始 errno/时间/命令身份），
  // 不再静默落到 poll 超时；提交点后异步失败经 stderr sink 保持可观察。
  try {
    const outputPath = prepareWatchdogProcessOutput(fsFactory);
    const outcome = await spawnDetached('node', [watchdogEntryPath], {
      env: {
        CHESTNUT_ROOT: legacyParent,
        [WATCHDOG_CANDIDATE_ATTEMPT_ENV]: attemptId,
      },
      cwd: legacyParent,
      logFile: outputPath,
      onSpawnFailure: (failure) => {
        const message = `[watchdog] post-commit spawn failure: command=${failure.command}` +
          ` pid=${failure.pid ?? 'unknown'} errno=${failure.errno ?? failure.code ?? 'unknown'}` +
          ` at=${failure.atMs}: ${failure.message}`;
        console.error(message);
        writeWatchdogRawFallback(fsFactory, `${message}\n`);
      },
    });
    if (outcome.kind === 'failed') {
      const f = outcome.failure;
      throw new Error(
        `Watchdog spawn pre-commit failure (command="${f.command}"` +
          ` errno=${f.errno ?? f.code ?? 'unknown'} at=${f.atMs}): ${f.message}`,
      );
    }

    for (let attempts = 0; ; attempts++) {
      const aliveWinner = inspectAliveWinner(fsFactory);
      if (aliveWinner !== null) return aliveWinner;
      if (attempts >= WATCHDOG_START_MAX_ATTEMPTS) break;
      await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
    }

    // A winner may commit while the polling budget expires. Recheck without another
    // sleep before attributing a terminal to this attempt.
    const aliveWinner = inspectAliveWinner(fsFactory);
    if (aliveWinner !== null) return aliveWinner;

    const evidence = inspectTerminalForAttempt(getChestnutFs(fsFactory), attemptId);
    if (evidence.kind === 'terminal') {
      if (evidence.terminal.kind === 'crashed') {
        const summary = evidence.terminal.reason.split(/\r?\n/, 1)[0]!.slice(0, 240);
        throw new WatchdogStartupCrashError(summary, evidence.terminal);
      }
      if (evidence.terminal.kind === 'stopped') {
        throw new Error(
          `Watchdog stopped during startup (${evidence.terminal.signal}). ` +
          `Check watchdog log at ${WATCHDOG_LOG_HINT}.`,
        );
      }
      throw new Error(`Watchdog startup ended unclean. Check watchdog log at ${WATCHDOG_LOG_HINT}.`);
    }
    if (evidence.kind === 'unknown') throw new WatchdogStartupUnconfirmedError(evidence);

    throw new Error(
      `Watchdog failed to start within ${(WATCHDOG_POLL_INTERVAL_MS * WATCHDOG_START_MAX_ATTEMPTS) / 1000}s. ` +
      // Phase 1878 Step K: 指向 Watchdog owner 日志面（watchdog-log 单源提示）。
      `Check watchdog log at ${WATCHDOG_LOG_HINT}.`,
    );
  } catch (error) {
    recordSpawnFailureBestEffort(fsFactory, attemptId, error);
    throw error;
  }
}
