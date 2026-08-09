/**
 * @module L6.CLI.WatchdogCli
 * Watchdog CLI subcommands — start + stop
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import { setTimeout } from 'timers/promises';
import { getWorkspaceRoot } from '../../core/claw-topology/index.js';
import { kill as defaultKill, isAlive as defaultIsAlive, isPidArgvMatching as defaultIsPidArgvMatching } from '../../foundation/process-exec/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  type WatchdogProcessDeps,
  getWatchdogEntryPath, getAuditWriter,
  getWatchdogPid, isWatchdogAlive, removeWatchdogPid, WatchdogPidForeignWorkspaceError,
  WATCHDOG_AUDIT_EVENTS,
  spawnWatchdogCandidate,
} from '../../watchdog/index.js';
import { CliError } from '../errors.js';

// Watchdog lifecycle poll：通用 100ms 间隔
const WATCHDOG_POLL_INTERVAL_MS = 100;

/**
 * stopCommand: 等 SIGTERM 后 daemon 退出的 poll attempts 上限.
 * Derivation: 100ms × 50 = 5s 总 timeout / 比 START 长 67% 因 stop 需 daemon 自己 flush
 * + 释资源 / 比 INTERRUPT_CLEANUP_TIMEOUT_MS=5000 同值（共享 graceful shutdown 协议）.
 */
const WATCHDOG_STOP_MAX_ATTEMPTS = 50;

/**
 * SIGKILL 后宽限期（watchdog daemon cleanup 子域）。
 * 500ms 已够 OS reap watchdog daemon 后清理 PID 文件 + lock。
 * 与 `EXEC_SIGKILL_GRACE_MS = 1000` (foundation/process-exec/exec.ts) 故意值不同：
 *   - WATCHDOG: 500ms — watchdog daemon、更快 cleanup
 *   - EXEC:    1000ms — user process、POSIX SIGTERM 行业惯例（systemd/kubelet/Docker 1s）
 * cross-ref `feedback_config_defaults_single_source` per-module 自治模板（phase 844 + 863 + 924 N=3 累）。
 */
const WATCHDOG_SIGKILL_GRACE_MS = 500;

/** Spawn watchdog candidate + CLI 外壳（console 输出 + CliError 错误格式）。
 *  核心 spawn + poll 委托 spawnWatchdogCandidate（watchdog/spawn.ts）。 */
export async function startCommand(
  fsFactory: (baseDir: string) => FileSystem,
  _deps?: WatchdogProcessDeps,
): Promise<void> {
  // 幂等：本 workspace 的 watchdog 已在运行则直接返回
  try {
    if (isWatchdogAlive(fsFactory)) {
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
    throw new CliError(
      `Watchdog failed to start within 3s. Check daemon log under .chestnut/logs/.`,
      1,
    );
  }
}

/** Stop watchdog daemon. */
export async function stopCommand(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): Promise<void> {
  const pid = getWatchdogPid(fsFactory);

  if (!pid || !isWatchdogAlive(fsFactory)) {
    // phase 804: PID file missing/stale → pgrep fallback to find running watchdog
    let actualPid: number | null = null;
    try {
      const pm = createProcessManagerForCLI({ fsFactory, baseDir: getWorkspaceRoot() });
      const watchdogEntryPath = getWatchdogEntryPath();
      const pids = pm.findProcesses(watchdogEntryPath);
      const verifyFn = deps?.isPidArgvMatching ?? defaultIsPidArgvMatching;
      for (const p of pids) {
        if (verifyFn(p, 'watchdog-entry')) {
          actualPid = p;
          break;
        }
      }
    } catch {
      // silent: pgrep unavailable → conservative, assume not running
    }

    if (actualPid) {
      console.log(`Watchdog PID file missing but process found (PID: ${actualPid}). Stopping...`);
      const killFn = deps?.kill ?? defaultKill;
      try {
        killFn(actualPid, 'TERM');
      } catch (err) {
        console.log('Failed to send SIGTERM:', err);
        getAuditWriter()?.write(WATCHDOG_AUDIT_EVENTS.STOP_SIGTERM_FAILED, `pid=${actualPid}`, `error=${formatErr(err)}`);
      }

      // Wait up to 5s
      let attempts = 0;
      const isAliveFn = deps?.isAlive ?? defaultIsAlive;
      while (isAliveFn(actualPid) && attempts < WATCHDOG_STOP_MAX_ATTEMPTS) {
        await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
        attempts++;
      }

      if (isAliveFn(actualPid)) {
        console.log('Watchdog still alive, sending SIGKILL...');
        try {
          killFn(actualPid, 'KILL');
        } catch (err) {
          console.log('Failed to send SIGKILL:', err);
          getAuditWriter()?.write(WATCHDOG_AUDIT_EVENTS.STOP_SIGKILL_FAILED, `pid=${actualPid}`, `error=${formatErr(err)}`);
        }
        await setTimeout(WATCHDOG_SIGKILL_GRACE_MS);
      }
    } else {
      console.log('Watchdog is not running');
    }

    // Phase 1203 Step E: 只清 legacy 输入 `watchdog.pid`；active owner 由被停进程自己的
    // generation-guarded shutdown retire，stop 不触碰 active 目录、不代宣称处置 generation。
    removeWatchdogPid(fsFactory);
    console.log('Watchdog stopped');
    return;
  }

  console.log(`Stopping watchdog (PID: ${pid})...`);

  try {
    (deps?.kill ?? defaultKill)(pid, 'TERM');
  } catch (err) {
    console.log('Failed to send SIGTERM:', err);
    // phase 472 (review N3-L): observability — SIGTERM 失败 emit audit
    getAuditWriter()?.write(WATCHDOG_AUDIT_EVENTS.STOP_SIGTERM_FAILED, `pid=${pid}`, `error=${formatErr(err)}`);
  }

  // Wait up to 5s
  let attempts = 0;
  while (isWatchdogAlive(fsFactory) && attempts < WATCHDOG_STOP_MAX_ATTEMPTS) {
    await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
    attempts++;
  }

  if (isWatchdogAlive(fsFactory)) {
    console.log('Watchdog still alive, sending SIGKILL...');
    try {
      (deps?.kill ?? defaultKill)(pid, 'KILL');
    } catch (err) {
      console.log('Failed to send SIGKILL:', err);
      // phase 472 (review N3-L): observability — SIGKILL 失败 emit audit
      getAuditWriter()?.write(WATCHDOG_AUDIT_EVENTS.STOP_SIGKILL_FAILED, `pid=${pid}`, `error=${formatErr(err)}`);
    }
    await setTimeout(WATCHDOG_SIGKILL_GRACE_MS);
  }

  // Phase 1203 Step E: 同上 —— 仅 legacy 输入兼容清理，active 目录留由 owner 自己 retire
  // （SIGKILL 未优雅退出时留作 stale，由下一 candidate generation-guarded recovery）。
  removeWatchdogPid(fsFactory);
  console.log('Watchdog stopped');
}
