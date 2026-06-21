/**
 * @module L6.Watchdog.Cli
 * Watchdog CLI subcommands — start + stop
 */

import { getWorkspaceRoot } from '../foundation/install-paths.js';
import { spawnDetached, kill as defaultKill } from '../foundation/process-exec/index.js';
import type { WatchdogProcessDeps } from './types.js';
import { setTimeout } from 'timers/promises';
import type { FileSystem } from '../foundation/fs/index.js';
import {
  getWatchdogEntryPath,
} from './watchdog-context.js';
import {
  getWatchdogPid, isWatchdogAlive, removeWatchdogPid, WatchdogPidForeignWorkspaceError,
} from './watchdog-pid.js';
import { CliError } from '../foundation/errors.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { getAuditWriter } from './watchdog-context.js';
import { formatErr } from '../foundation/utils/index.js';

// Watchdog lifecycle poll：通用 100ms 间隔
const WATCHDOG_POLL_INTERVAL_MS = 100;

/**
 * startCommand: 等 PID 文件写入的 poll attempts 上限.
 * Derivation: 100ms × 30 = 3s 总 timeout / 配 WATCHDOG_POLL_INTERVAL_MS=100 /
 * 比 LOCK_ACQUIRE_TIMEOUT_MS=3000 同值 / 给 daemon spawn 完成 PID 写入足够时间.
 */
const WATCHDOG_START_MAX_ATTEMPTS = 30;

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

/** 1:1 保 watchdog.ts:514-543 / startCommand */
export async function startCommand(
  fsFactory: (baseDir: string) => FileSystem,
  _deps?: WatchdogProcessDeps,
): Promise<void> {
  const watchdogEntryPath = getWatchdogEntryPath(fsFactory);

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

  // spawn watchdog，显式传 CHESTNUT_ROOT
  const chestnutRoot = getWorkspaceRoot();
  // phase 518 (review-round4 CLI M3、phase 458 gap 补完): 显式传 cwd 防子进程继承
  // watchdog-cli process.cwd（test/multi-workspace 污染）。phase 458 只覆盖 motion
  // restart spawn、本 phase 补 initial watchdog spawn 同款。
  spawnDetached('node', [watchdogEntryPath], {
    env: { ...process.env, CHESTNUT_ROOT: chestnutRoot },
    cwd: chestnutRoot,
  });

  // 等待 PID 文件写入
  let attempts = 0;
  while (!isWatchdogAlive(fsFactory) && attempts < WATCHDOG_START_MAX_ATTEMPTS) {
    await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
    attempts++;
  }

  const pid = getWatchdogPid(fsFactory);
  if (pid) {
    console.log(`Watchdog started (PID: ${pid})`);
  } else {
    // phase 324 H2: throw CliError 让 wrapper 映射真退出码、不再 exit 0 静默
    throw new CliError(
      `Watchdog failed to start within ${(WATCHDOG_POLL_INTERVAL_MS * WATCHDOG_START_MAX_ATTEMPTS) / 1000}s. ` +
      `Check daemon log under .chestnut/logs/.`,
      1,
    );
  }
}

/** 1:1 保 watchdog.ts:545-580 / stopCommand */
export async function stopCommand(
  fsFactory: (baseDir: string) => FileSystem,
  deps?: WatchdogProcessDeps,
): Promise<void> {
  const pid = getWatchdogPid(fsFactory);
  
  if (!pid || !isWatchdogAlive(fsFactory)) {
    console.log('Watchdog is not running');
    removeWatchdogPid(fsFactory);
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
  
  removeWatchdogPid(fsFactory);
  console.log('Watchdog stopped');
}
