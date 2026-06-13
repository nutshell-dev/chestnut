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

import { makeChestnutRoot } from '../foundation/install-paths.js';
import * as path from 'path';
import { formatErr } from "../foundation/utils/index.js";
import { setTimeout } from 'timers/promises';
import { getNamedSubrootDir } from '../foundation/config/index.js';
import { MOTION_CLAW_ID, makeClawId } from '../constants.js';
import type { FileSystem } from '../foundation/fs/types.js';
import { isFileNotFound } from '../foundation/fs/types.js';
import { type AuditLog, createAuditWriter } from '../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../foundation/process-manager/index.js';
import { LockConflictError } from '../foundation/process-manager/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../foundation/process-manager/audit-events.js';
import { CLAWS_DIR } from '../foundation/claw-paths.js';
import { resolveDaemonEntry } from '../assembly/spawn-entry.js';
import { DAEMON_LOG } from '../daemon/constants.js';


import {
  getChestnutDir, getChestnutFs, getGlobalConfig, setAuditWriter,
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
  maybeCronClawInactivity, maybeCronClawCrash, maybeCronCheckSubscriptions,
} from './watchdog-cron.js';

const WATCHDOG_BACKOFF_MAX_MS = 5 * 60 * 1000;   // 5 minutes

// phase 324 H3: 连续 motion restart 失败 cap，触顶进 circuit-open。
// 默 10 次。env WATCHDOG_MAX_RESTART 设有效正整数时覆盖。
const WATCHDOG_MAX_RESTART_DEFAULT = 10;
function getMaxRestart(): number {
  const raw = process.env.WATCHDOG_MAX_RESTART;
  if (!raw) return WATCHDOG_MAX_RESTART_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : WATCHDOG_MAX_RESTART_DEFAULT;
}

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
    saveFailed = formatErr(err);
    log(fsFactory, `[watchdog] Failed to save state: ${saveFailed}`);
  }
  removeWatchdogPid(fsFactory);
  if (saveFailed) {
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.STOP, `signal=${signal}`, `save_failed=${auditWriter.message(saveFailed)}`);
  } else {
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.STOP, `signal=${signal}`);
  }
  process.exit(saveFailed ? 1 : 0);
}

// === Motion restart helper ===

interface RestartMotionResult {
  newBackoff: number;
  newFailures: number;
}

async function restartMotionIfDown(
  pm: ReturnType<typeof createProcessManagerForCLI>,
  fsFactory: (baseDir: string) => FileSystem,
  audit: AuditLog,
  status: ReturnType<ReturnType<typeof createProcessManagerForCLI>['getAliveStatus']>,
  failures: number,
  baseInterval: number,
  maxBackoff: number,
): Promise<RestartMotionResult> {
  if (status.alive) {
    return { newBackoff: baseInterval, newFailures: 0 };
  }

  log(fsFactory, `[watchdog] motion down (${status.reason}), restarting...`);
  audit.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED, MOTION_CLAW_ID);
  log(fsFactory, `[watchdog] motion down (${status.reason}), restarting...`);

  try {
    // best-effort cleanup before respawn / per phase 636 ratify:
    //   - cleanup failure 可能源:
    //     (a) 真 stale PID 文件 → safe to ignore (audit captures)
    //     (b) motion 仍活（race / 另 watchdog instance spawn 中）→ spawn 抛 LockConflictError、捕获后 reset 计数
    //   - cleanup 失败不阻塞 respawn / spawn 自身判 race / failure 仅 audit observability
    await pm.stop(MOTION_CLAW_ID).catch((e) => {
      const msg = `[watchdog] Failed to clean up motion before restart: ${formatErr(e)}`;
      logWithAudit(fsFactory, msg, WATCHDOG_AUDIT_EVENTS.CLEANUP_FAILED, audit.message(msg));
    });
    const daemonEntryPath = resolveDaemonEntry(fsFactory(process.cwd()));
    const chestnutRoot = makeChestnutRoot(getChestnutDir());
    const pid = await pm.spawn(MOTION_CLAW_ID, {
      command: 'node',
      args: [daemonEntryPath, MOTION_CLAW_ID],
      logFile: path.join(getNamedSubrootDir('motion'), DAEMON_LOG),
      env: { ...process.env, CHESTNUT_ROOT: path.dirname(chestnutRoot) } as Record<string, string | undefined>,
    });
    log(fsFactory, `[watchdog] motion restarted (PID=${pid})`);
    audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED, MOTION_CLAW_ID, `pid=${pid}`);
    return { newBackoff: baseInterval, newFailures: 0 };
  } catch (err) {
    if (err instanceof LockConflictError) {
      // phase 324 H3 锚：LockConflictError 重置 failures 是 intentional —— 失锁意味着另
      // 一个 watchdog 实例赢了 race、不是本机 motion spawn 失败，所以不入失败计数。
      log(fsFactory, `[watchdog] motion already started by another instance`);
      return { newBackoff: baseInterval, newFailures: 0 };
    }
    const newFailures = failures + 1;
    const newBackoff = Math.min(baseInterval * Math.pow(2, newFailures - 1), maxBackoff);
    audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWN_FAILED, MOTION_CLAW_ID, `error=${formatErr(err)}`);
    log(fsFactory, `[watchdog] FAILED to restart motion (failure #${newFailures}): ${err}`);
    return { newBackoff, newFailures };
  }
}

// === Main loop ===

/** 1:1 保 watchdog.ts:402-513 */
export async function runWatchdogLoop(fsFactory: (baseDir: string) => FileSystem): Promise<void> {
  log(fsFactory, '[watchdog] Daemon starting...');

  writeWatchdogPid(fsFactory, process.pid);

  // 先建 auditWriter，让 loadWatchdogState corrupt 路径可写 audit（N1 修复）
  const auditMaxSizeMb = getGlobalConfig(fsFactory).audit.retention.max_size_mb;
  const auditWriter = createAuditWriter(
    getChestnutFs(fsFactory),
    'audit.tsv',
    auditMaxSizeMb,
  );
  setAuditWriter(auditWriter);

  loadWatchdogState(fsFactory);   // 恢复通知状态（_auditWriter 已设，corrupt 路径可写 audit）
  log(fsFactory, '[watchdog] State loaded.');

  auditWriter.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_START);

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
  // phase 324 H3: circuit-open flag — 一旦触顶，停止 spawn 直到手动重启 watchdog。
  let gaveUpOnMotion = false;
  const maxRestart = getMaxRestart();

  while (!stopped) {
    // 1. Check motion liveness
    const status = pm.getAliveStatus(MOTION_CLAW_ID);

    // watchdog_check: 枚举所有存活进程
    const aliveIds: string[] = [];
    const presentClawIds: string[] = [];
    if (status.alive) aliveIds.push(MOTION_CLAW_ID);
    const fs = getChestnutFs(fsFactory);
    if (fs.existsSync(CLAWS_DIR)) {
      try {
        for (const entry of fs.listSync(CLAWS_DIR, { includeDirs: true })) {
          if (entry.isDirectory) {
            presentClawIds.push(entry.name);
            const clawId = entry.name;
            if (pm.isAlive(makeClawId(clawId))) aliveIds.push(entry.name);
          }
        }
      } catch (err) {
        if (!isFileNotFound(err)) {
          auditWriter.write(
            WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
            `ctx=watchdog_tick`,
            `error=${formatErr(err)}`,
          );
        }
        // ENOENT after existsSync = race（合法）/ 其他错 audit / treat as empty（下 tick 重试）
      }
    }
    auditWriter.write(WATCHDOG_AUDIT_EVENTS.WATCHDOG_CHECK, `alive=${aliveIds.join(',')} present=${presentClawIds.join(',')}`);

    const intervalMs = getGlobalConfig(fsFactory).watchdog.interval_ms;
    let nextSleepMs: number;
    if (gaveUpOnMotion) {
      // circuit-open: 不再 spawn、按 max backoff idle、cron 仍跑（claw 监控不停）
      nextSleepMs = WATCHDOG_BACKOFF_MAX_MS;
      if (status.alive) {
        // motion 莫名活过来了（手动重启）→ 解 circuit-open、回 normal mode
        log(fsFactory, '[watchdog] motion is alive again, reopening circuit');
        gaveUpOnMotion = false;
        motionRestartFailures = 0;
        nextSleepMs = intervalMs;
      }
    } else if (motionRestartFailures >= maxRestart && !status.alive) {
      // phase 324 H3: 触顶 → circuit-open。停 spawn、audit 一条 GAVE_UP、
      // 等待手动重启或 motion 自己恢复（外部 supervisor 拉起）。
      gaveUpOnMotion = true;
      auditWriter.write(
        WATCHDOG_AUDIT_EVENTS.WATCHDOG_GAVE_UP,
        `consecutive_failures=${motionRestartFailures}`,
        `cap=${maxRestart}`,
        `reason=motion_unrecoverable`,
      );
      log(
        fsFactory,
        `[watchdog] gave up restarting motion after ${motionRestartFailures} consecutive failures (cap=${maxRestart}); ` +
        `entering circuit-open. Restart watchdog manually after fixing motion.`,
      );
      nextSleepMs = WATCHDOG_BACKOFF_MAX_MS;
    } else {
      const { newBackoff, newFailures } = await restartMotionIfDown(
        pm,
        fsFactory,
        auditWriter,
        status,
        motionRestartFailures,
        intervalMs,
        WATCHDOG_BACKOFF_MAX_MS,
      );
      motionRestartFailures = newFailures;
      nextSleepMs = newBackoff;
    }

    // 2. Cron checks (disk_check moved to CronRunner in daemon.ts)
    await maybeCronClawInactivity(pm, auditWriter, fsFactory);
    maybeCronClawCrash(pm, auditWriter, fsFactory);
    // phase 5: process motion-requested subscriptions (file-based dir scan)
    await maybeCronCheckSubscriptions(pm, auditWriter, fsFactory);
    saveWatchdogState(fsFactory);   // 持久化通知状态（每 tick 一次）

    // 3. Sleep with backoff on consecutive failures (max 5 minutes) — or circuit-open idle
    await setTimeout(nextSleepMs);
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
  maybeCronClawInactivity, maybeCronClawCrash, maybeCronCheckSubscriptions,
} from './watchdog-cron.js';

export {
  startCommand, stopCommand,
} from './watchdog-cli.js';
