/**
 * @module L6.Watchdog
 * @layer L6 进程边界（Watchdog 守护进程）
 * @depends L1.FileSystem, L2.AuditLog, L2.Messaging, L2.ProcessManager, L6.CLI
 * @consumers L6.CLI（spawn）
 * @contract design/modules/l6_watchdog.md
 *
 * Watchdog 守护进程 — 每 30s 检查 motion 存活 / 内建简易 cron。
 *
 * 内部物理拆 sub-file：
 * - watchdog-context.ts   5 module-level state + 3 Map（cron state）+ getter/setter
 * - watchdog-pid.ts       PID file mgmt（5 function）
 * - watchdog-log.ts       log + audit + inbox message（4 function）
 * - watchdog-state.ts     state 持久化（4 function）
 * - watchdog-cron.ts      maybeCronClawInactivity + maybeCronClawCrash（2 业务）
 * - watchdog-cli.ts       startCommand + stopCommand（2 cli）
 *
 * 本 file 保：runWatchdogLoop（main loop）+ shutdownWatchdog（graceful stop）+ barrel re-export
 */

import * as path from 'path';
import { setTimeout } from 'timers/promises';
import { getNamedSubrootDir } from '../foundation/config/index.js';
import { MOTION_CLAW_ID } from '../constants.js';
import { makeClawId, makeClawforumRoot, makeClawDir } from '../foundation/identity/index.js';
import type { FileSystem } from '../foundation/fs/types.js';
import { type AuditLog, createAuditWriter } from '../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import { LockConflictError } from '../foundation/process-manager/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { CLAWS_DIR, resolveDaemonEntry } from '../foundation/paths.js';
import { DAEMON_LOG } from '../daemon/constants.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../foundation/audit/index.js';

import {
  getClawforumDir, getClawforumFs, getGlobalConfig, setAuditWriter,
} from './watchdog-context.js';
import {
  writeWatchdogPid, removeWatchdogPid,
} from './watchdog-pid.js';
import {
  log, logWithAudit,
} from './watchdog-log.js';
import {
  loadWatchdogState, saveWatchdogState,
} from './watchdog-state.js';
import {
  maybeCronClawInactivity, maybeCronClawCrash,
} from './watchdog-cron.js';

const WATCHDOG_BACKOFF_MAX_MS = 5 * 60 * 1000;   // 5 minutes

// === Shutdown (21 行) ===

/** Module-level guard: prevent reentrant shutdown when SIGTERM + SIGINT both fire */
let shuttingDown = false;
let sigtermHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

/** Test-only: reset shutdown guard between tests */
export function _resetShutdownGuard(): void {
  shuttingDown = false;
  if (sigtermHandler) {
    process.removeListener('SIGTERM', sigtermHandler);
    sigtermHandler = null;
  }
  if (sigintHandler) {
    process.removeListener('SIGINT', sigintHandler);
    sigintHandler = null;
  }
}

/** 1:1 保 watchdog.ts:100-120 */
export function shutdownWatchdog(
  fsFactory: (baseDir: string) => FileSystem,
  auditWriter: AuditLog,
  signal: string,
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(fsFactory, `[watchdog] Received ${signal}, shutting down...`);
  let saveFailed: string | undefined;
  try {
    saveWatchdogState(fsFactory);
  } catch (err) {
    saveFailed = err instanceof Error ? err.message : String(err);
    log(fsFactory, `[watchdog] Failed to save state: ${saveFailed}`);
  }
  removeWatchdogPid(fsFactory);
  if (saveFailed) {
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.STOP, `signal=${signal}`, `save_failed=${saveFailed.slice(0, AUDIT_MESSAGE_MAX_CHARS)}`);
  } else {
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.STOP, `signal=${signal}`);
  }
  process.exit(saveFailed ? 1 : 0);
}

// === Main loop (112 行) ===

/** 1:1 保 watchdog.ts:402-513 */
export async function runWatchdogLoop(fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  log(fsFactory, '[watchdog] Daemon starting...');

  writeWatchdogPid(fsFactory, process.pid);

  // 先建 auditWriter，让 loadWatchdogState corrupt 路径可写 audit（N1 修复）
  const auditMaxSizeMb = getGlobalConfig(fsFactory).audit?.retention?.max_size_mb ?? null;
  const auditWriter = createAuditWriter(
    getClawforumFs(fsFactory),
    'audit.tsv',
    auditMaxSizeMb,
  );
  setAuditWriter(auditWriter);

  loadWatchdogState(fsFactory);   // 恢复通知状态（_auditWriter 已设，corrupt 路径可写 audit）
  log(fsFactory, '[watchdog] State loaded.');

  auditWriter.write('watchdog_start');

  let stopped = false;
  
  // Create Motion ProcessManager (reused across loop iterations)
  const pm = createProcessManagerForCLI({ fsFactory });

  // phase 1034: idempotent install / 防 test re-entry 或 production 异常 re-entry 累 listener (Node maxListeners warning)
  // mirror _resetShutdownGuard removeListener pattern (line 60-66) — install 前 cleanup prior
  if (sigtermHandler) process.removeListener('SIGTERM', sigtermHandler);
  if (sigintHandler) process.removeListener('SIGINT', sigintHandler);

  sigtermHandler = () => {
    stopped = true;
    shutdownWatchdog(fsFactory, auditWriter, 'SIGTERM');
  };
  sigintHandler = () => {
    stopped = true;
    shutdownWatchdog(fsFactory, auditWriter, 'SIGINT');
  };
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);
  
  // Motion restart failure tracking for backoff
  let motionRestartFailures = 0;

  while (!stopped) {
    // 1. Check motion liveness
    const status = pm.getAliveStatus(MOTION_CLAW_ID);
    
    // watchdog_check: 枚举所有存活进程
    const aliveIds: string[] = [];
    const presentClawIds: string[] = [];
    if (status.alive) aliveIds.push(MOTION_CLAW_ID);
    const fs = getClawforumFs(fsFactory);
    if (fs.existsSync(CLAWS_DIR)) {
      for (const entry of fs.listSync(CLAWS_DIR, { includeDirs: true })) {
        if (entry.isDirectory) {
          presentClawIds.push(entry.name);
          const clawId = makeClawId(entry.name);
          if (pm.isAlive(clawId)) aliveIds.push(entry.name);
        }
      }
    }
    auditWriter.write('watchdog_check', `alive=${aliveIds.join(',')} present=${presentClawIds.join(',')}`);
    
    if (!status.alive) {
      log(fsFactory, `[watchdog] motion down (${status.reason}), restarting...`);
      auditWriter.write('watchdog_restart_triggered', MOTION_CLAW_ID);
      log(fsFactory, `[watchdog] motion down (${status.reason}), restarting...`);
      try {
        // best-effort cleanup before respawn / per phase 636 ratify:
        //   - cleanup failure 可能源:
        //     (a) 真 stale PID 文件 → safe to ignore (audit captures)
        //     (b) motion 仍活（race / 另 watchdog instance spawn 中）→ spawn 抛 LockConflictError、捕获后 reset 计数
        //   - cleanup 失败不阻塞 respawn / spawn 自身判 race / failure 仅 audit observability
        await pm.stop(MOTION_CLAW_ID).catch((e) => {
          const msg = `[watchdog] Failed to clean up motion before restart: ${e instanceof Error ? e.message : String(e)}`;
          logWithAudit(fsFactory, msg, WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED, msg.slice(0, AUDIT_MESSAGE_MAX_CHARS));
        });
        const daemonEntryPath = resolveDaemonEntry(fsFactory(process.cwd()));
        const clawforumRoot = makeClawforumRoot(getClawforumDir());
        const pid = await pm.spawn(MOTION_CLAW_ID, {
          command: 'node',
          args: [daemonEntryPath, MOTION_CLAW_ID],
          logFile: path.join(makeClawDir(getNamedSubrootDir('motion')), DAEMON_LOG),
          env: { ...process.env, CLAWFORUM_ROOT: path.dirname(clawforumRoot) } as Record<string, string | undefined>,
        });
        log(fsFactory, `[watchdog] motion restarted (PID=${pid})`);
        auditWriter.write('process_spawn', MOTION_CLAW_ID, `pid=${pid}`);
        motionRestartFailures = 0;  // Success, reset counter
      } catch (err) {
        if (err instanceof LockConflictError) {
          // 另一个 watchdog 实例已经启动了 motion，不算失败
          log(fsFactory, `[watchdog] motion already started by another instance`);
          motionRestartFailures = 0;
        } else {
          motionRestartFailures++;
          auditWriter.write('process_spawn_failed', MOTION_CLAW_ID, `error=${err instanceof Error ? err.message : String(err)}`);
          log(fsFactory, `[watchdog] FAILED to restart motion (failure #${motionRestartFailures}): ${err}`);
        }
      }
    } else {
      motionRestartFailures = 0;  // Motion healthy, reset counter
    }
    
    // 2. Cron checks (disk_check moved to CronRunner in daemon.ts)
    await maybeCronClawInactivity(pm, auditWriter, fsFactory);
    maybeCronClawCrash(pm, auditWriter, fsFactory);
    saveWatchdogState(fsFactory);   // 持久化通知状态（每 tick 一次）
    
    // 3. Sleep with backoff on consecutive failures (max 5 minutes)
    const intervalMs = getGlobalConfig(fsFactory).watchdog?.interval_ms ?? 30000;
    const backoffMs = motionRestartFailures > 0
      ? Math.min(intervalMs * Math.pow(2, motionRestartFailures - 1), WATCHDOG_BACKOFF_MAX_MS)
      : intervalMs;
    await setTimeout(backoffMs);
  }
}

// === Barrel re-export 全集中（保 caller cascade 0 改）===

export {
  getWatchdogEntryPath, getMotionContext, setAuditWriter,
} from './watchdog-context.js';

export {
  getWatchdogPid, isWatchdogAlive, writeWatchdogPid, removeWatchdogPid,
} from './watchdog-pid.js';

export {
  log, logWithAudit, writeClawInactivityInbox,
} from './watchdog-log.js';

export {
  loadWatchdogState, saveWatchdogState, writeWatchdogCrash,
} from './watchdog-state.js';

export {
  maybeCronClawInactivity, maybeCronClawCrash,
} from './watchdog-cron.js';

export {
  startCommand, stopCommand,
} from './watchdog-cli.js';
