/**
 * @module L6.Daemon
 * @layer L6 进程边界（Daemon 事件循环）
 * @depends L1.FileSystem, L2.AuditLog, L2.FileWatcher, L5.EventLoop
 * @consumers L6.Daemon
 * @contract design/modules/l6_daemon.md
 *
 * 通用 daemon 事件循环 — motion 和 claw 共用。
 * 进程级职责：心跳、interrupt watcher、启动检查。
 * 轮次调度逻辑全部委托 L5.EventLoop。
 */

import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { createHourlyHeartbeatAccumulator } from '../foundation/audit/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import { createInterruptWatcher } from './interrupt-watcher.js';
import { startWaitingStallMonitor } from './waiting-stall.js';
import type { Watcher, WatcherFactory } from '../foundation/file-watcher/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { shouldEmitStartupCheck } from './startup-check.js';
import {
  INTERRUPT_POLL_MAX_ERRORS,
  INTERRUPT_POLL_RECOVERY_BACKOFF_MS,
  INTERRUPT_POLL_WARN_EVERY,
  DAEMON_HEARTBEAT_WRITE_INTERVAL_MS,
  DAEMON_HEARTBEAT_FILENAME,
} from './constants.js';
import type { EventLoop } from '../core/event-loop/index.js';

/** motion 专用扩展（claw daemon 整体省略此组） */
interface DaemonMotionExtensions {
  heartbeat?: Heartbeat;
}

export interface DaemonLoopOptions {
  // 核心驱动
  fsFactory: (baseDir: string) => FileSystem;
  eventLoop: EventLoop;
  agentDir: string;          // agent root directory (listens for interrupt signals)
  clawId: string;            // agent identifier (kebab-case)
  label: string;             // log prefix, e.g. '[motion daemon]' or '[daemon]'
  audit: AuditLog;           // audit sink

  // motion 专用扩展（claw 整体省略）
  motion?: DaemonMotionExtensions;

  /** watcher factory。测试可注入 fake 避免真实 chokidar。默认 createWatcher。 */
  createWatcher?: WatcherFactory;
}

/**
 * Run the daemon event loop.
 * Returns a promise and a stop function.
 */
export function startDaemonLoop(options: DaemonLoopOptions): {
  promise: Promise<void>;
  stop: () => void;
} {
  const { fsFactory, eventLoop, agentDir, audit, motion, createWatcher } = options;
  const heartbeat = motion?.heartbeat;
  const agentFs = fsFactory(agentDir);
  let stopped = false;
  let stopping = false;
  let startupFired = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  // phase 1154 r+ derive: 60s liveness 心跳（B + 心跳混合方案）
  const LIVENESS_HEARTBEAT_MS = 60_000;
  const hourlyHeartbeat = createHourlyHeartbeatAccumulator({
    onHourly: (tickCount, elapsedMs) => {
      audit.write(
        DAEMON_AUDIT_EVENTS.LIVENESS_HOURLY,
        `ticks=${tickCount}`,
        `elapsed_ms=${elapsedMs}`,
        `uptime_s=${Math.round(process.uptime())}`,
      );
    },
  });
  const livenessTimer = setInterval(() => {
    audit.write(
      DAEMON_AUDIT_EVENTS.LIVENESS_HEARTBEAT,
      `pid=${process.pid}`,
      `uptime_s=${Math.round(process.uptime())}`,
    );
    hourlyHeartbeat.tick();
  }, LIVENESS_HEARTBEAT_MS);
  livenessTimer.unref(); // 不阻 event loop 退出

  // phase 1383 Step D (U4): 心跳文件 —— Watchdog 进程外兜底事件循环全阻塞。
  // 周期写 ISO 时间戳到 <agentDir>/heartbeat；关停时 unlink 防「死进程留旧心跳」误判。
  // 注意：写动作本身在事件循环上，全阻塞时它也停写 → 时间戳过期正是 Watchdog 判定信号。
  const writeHeartbeat = (): void => {
    try {
      agentFs.writeAtomicSync(DAEMON_HEARTBEAT_FILENAME, new Date().toISOString());
    } catch (err) {
      // silent best-effort：心跳写失败不应崩 daemon；Watchdog 侧读失败有独立 audit。
      audit.write(DAEMON_AUDIT_EVENTS.LOOP_FATAL, `reason=heartbeat_write_failed`, `error=${formatErr(err)}`);
    }
  };
  const clearHeartbeat = (): void => {
    try {
      agentFs.deleteSync(DAEMON_HEARTBEAT_FILENAME);
    } catch {
      // silent: 关停清理 best-effort，心跳文件缺失/删除失败不阻塞 stop（下一 tick 进程已不在）。
    }
  };
  writeHeartbeat();  // 启动即写一次（避免升级后首次 tick 前空窗）
  const heartbeatTimer = setInterval(writeHeartbeat, DAEMON_HEARTBEAT_WRITE_INTERVAL_MS);
  heartbeatTimer.unref();

  // phase 1383 (P2b U3): in-process 自活监测 —— active 契约 + 等待态超长 → 自愈重入轮。
  // 只对 claw daemon 启用（motion 无契约、其停滞归 P3 教学/治理）。
  const isClawDaemon = motion === undefined;
  const waitingStall = isClawDaemon
    ? startWaitingStallMonitor({
        fsFactory,
        agentDir,
        audit,
        eventLoop,
      })
    : null;
  eventLoop.setOnTurnActivity(waitingStall ? () => waitingStall.noteActivity() : undefined);

  const stop = () => {
    stopping = true;
    stopped = true;
    waitingStall?.stop();
    clearInterval(heartbeatTimer);
    clearHeartbeat();
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  };

  const promise = (async () => {
    while (!stopped) {
      // Startup single-fire: has active contract + inbox is empty → trigger once in-process（写 status/startup_check_ts + notifyInbox 落 inbox 文件，两处磁盘写）
      if (!startupFired) {
        startupFired = true;
        if (shouldEmitStartupCheck(agentFs, audit)) {
          const STATUS_SUBDIR = 'status';
          agentFs.ensureDirSync(STATUS_SUBDIR);
          agentFs.writeAtomicSync(path.join(STATUS_SUBDIR, 'startup_check_ts'), String(Date.now()));
          notifyInbox(fsFactory(path.join(agentDir, '..')), {
            inboxDir: path.join(agentDir, 'inbox', 'pending'),
            type: 'startup_check',
            source: 'daemon',
            priority: 'high',
            body: 'System startup. Please review active contracts and resume execution.',
          }, audit);
        }
      }

      // Heartbeat check (moved into daemon loop to avoid setInterval race conditions)
      if (heartbeat?.isDue()) {
        await heartbeat.fire();
      }

      let interruptWatcher: Watcher | null = null;

      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }

      try {
        // Event-driven interrupt watcher (phase 361: 替原 setInterval polling)
        let interruptErrCount = 0;
        const onInterrupt = (): void => {
          eventLoop.abort();
          interruptErrCount = 0;
        };
        const onInterruptError = (err: Error): void => {
          interruptErrCount++;
          // phase 123: per-WARN_EVERY audit emit (DP「不丢弃静默」)
          if (interruptErrCount % INTERRUPT_POLL_WARN_EVERY === 0) {
            audit.write(
              DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_ERROR,
              `error_count=${interruptErrCount}`,
              `last_error=${formatErr(err)}`,
            );
          }
          if (interruptErrCount >= INTERRUPT_POLL_MAX_ERRORS) {
            audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED, `error_count=${interruptErrCount}`, `last_error=${formatErr(err)}`);
            // silent: disable path; close 失败不阻塞 recovery setTimeout 路径
            interruptWatcher?.close().catch(() => { /* silent: disable cleanup */ });
            interruptWatcher = null;
            // phase 229: DP「中断可恢复」+ DP「系统能自己做的就自己做好」delayed retry recovery
            // phase 1072: wrap recovery in try/catch + bounded exponential backoff + cancel on stop.
            const MAX_RECOVERY_RETRIES = 5;
            const INITIAL_BACKOFF = INTERRUPT_POLL_RECOVERY_BACKOFF_MS;
            const MAX_BACKOFF = 5 * 60 * 1000;
            let recoveryFailures = 0;
            let backoff = INITIAL_BACKOFF;

            const tryRecover = () => {
              if (stopping) return;
              try {
                interruptErrCount = 0;
                audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_RECOVERY_ATTEMPT, `backoff_ms=${backoff}`);
                interruptWatcher = createInterruptWatcher({
                  agentFs, agentDir, onInterrupt, onError: onInterruptError, createWatcher,
                });
                audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_RECOVERED);
                backoff = INITIAL_BACKOFF;
                recoveryFailures = 0;
              } catch (err) {
                recoveryFailures++;
                audit.write(
                  DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_RECOVERY_FAILED,
                  `attempt=${recoveryFailures}`,
                  `reason=${formatErr(err)}`,
                );
                if (recoveryFailures < MAX_RECOVERY_RETRIES && !stopping) {
                  backoff = Math.min(backoff * 2, MAX_BACKOFF);
                  recoveryTimer = setTimeout(tryRecover, backoff);
                }
              }
            };
            recoveryTimer = setTimeout(tryRecover, backoff);
          }
        };

        interruptWatcher = createInterruptWatcher({
          agentFs, agentDir, onInterrupt, onError: onInterruptError, createWatcher,
        });

        try {
          // 核心变更：委托 EventLoop 处理所有调度逻辑
          await eventLoop.run();
        } finally {
          if (interruptWatcher) {
            // silent: cleanup path; close 失败不影响 finally 后续
            await interruptWatcher.close().catch(() => { /* silent: cleanup */ });
            interruptWatcher = null;
          }
        }
      } catch (err) {
        // 只处理进程级错误（EventLoop 自身异常）
        // 不再做 LLM 错误分类和 retry 决策
        if (interruptWatcher) {
          // silent: error path; close 失败不影响 dispatchError
          await interruptWatcher.close().catch(() => { /* silent: cleanup */ });
          interruptWatcher = null;
        }
        audit.write(DAEMON_AUDIT_EVENTS.LOOP_FATAL, `reason=eventloop_crash`, `error=${formatErr(err)}`);
      }
    }
    clearInterval(livenessTimer);
    clearInterval(heartbeatTimer);
    clearHeartbeat();
  })();

  return { promise, stop };
}
