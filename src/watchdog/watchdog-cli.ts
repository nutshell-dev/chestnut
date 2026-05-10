/**
 * @module L6.Watchdog.Cli
 * Watchdog CLI subcommands — start + stop
 */

import { spawnDetached, kill } from '../foundation/process-exec/index.js';
import { setTimeout } from 'timers/promises';
import {
  getWatchdogEntryPath,
} from './watchdog-context.js';
import {
  writeWatchdogPid, getWatchdogPid, isWatchdogAlive, removeWatchdogPid,
} from './watchdog-pid.js';

// Watchdog lifecycle poll：通用 100ms 间隔
const WATCHDOG_POLL_INTERVAL_MS = 100;

// startCommand: 等 PID 文件写入 / 100ms × 30 = 3s 总 timeout
const WATCHDOG_START_MAX_ATTEMPTS = 30;

// stopCommand: 等 SIGTERM 后退出 / 100ms × 50 = 5s 总 timeout
const WATCHDOG_STOP_MAX_ATTEMPTS = 50;

// SIGKILL 后宽限期（让 OS 完成进程清理）
const WATCHDOG_SIGKILL_GRACE_MS = 500;

/** 1:1 保 watchdog.ts:514-543 / startCommand */
export async function startCommand(): Promise<void> {
  const watchdogEntryPath = getWatchdogEntryPath();

  // 幂等：本 workspace 的 watchdog 已在运行则直接返回
  if (isWatchdogAlive()) {
    console.log(`Watchdog already running (PID: ${getWatchdogPid()})`);
    return;
  }

  // spawn watchdog，显式传 CLAWFORUM_ROOT
  const clawforumRoot = process.env.CLAWFORUM_ROOT ?? process.cwd();
  spawnDetached('node', [watchdogEntryPath], {
    env: { ...process.env, CLAWFORUM_ROOT: clawforumRoot },
  });

  // 等待 PID 文件写入
  let attempts = 0;
  while (!isWatchdogAlive() && attempts < WATCHDOG_START_MAX_ATTEMPTS) {
    await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
    attempts++;
  }

  const pid = getWatchdogPid();
  if (pid) {
    console.log(`Watchdog started (PID: ${pid})`);
  } else {
    console.log('Watchdog may have failed to start');
  }
}

/** 1:1 保 watchdog.ts:545-580 / stopCommand */
export async function stopCommand(): Promise<void> {
  const pid = getWatchdogPid();
  
  if (!pid || !isWatchdogAlive()) {
    console.log('Watchdog is not running');
    removeWatchdogPid();
    return;
  }
  
  console.log(`Stopping watchdog (PID: ${pid})...`);
  
  try {
    kill(pid, 'TERM');
  } catch (err) {
    console.log('Failed to send SIGTERM:', err);
  }
  
  // Wait up to 5s
  let attempts = 0;
  while (isWatchdogAlive() && attempts < WATCHDOG_STOP_MAX_ATTEMPTS) {
    await setTimeout(WATCHDOG_POLL_INTERVAL_MS);
    attempts++;
  }
  
  if (isWatchdogAlive()) {
    console.log('Watchdog still alive, sending SIGKILL...');
    try {
      kill(pid, 'KILL');
    } catch (err) {
      console.log('Failed to send SIGKILL:', err);
    }
    await setTimeout(WATCHDOG_SIGKILL_GRACE_MS);
  }
  
  removeWatchdogPid();
  console.log('Watchdog stopped');
}
