/**
 * @module L6.Daemon
 * @layer L6 进程边界（Daemon 事件循环）
 * @depends L1.FileSystem, L2.AuditLog, L2.FileWatcher, L5.EventLoop
 * @consumers L6.Daemon
 * @contract design/modules/l6_daemon.md
 *
 * 通用 daemon 事件循环 — motion 和 claw 共用。
 * 进程级职责：心跳、watchdog、interrupt watcher、启动检查。
 * 轮次调度逻辑全部委托 L5.EventLoop。
 */

import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import { createInterruptWatcher } from './interrupt-watcher.js';
import type { Watcher, WatcherFactory } from '../foundation/file-watcher/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { shouldEmitStartupCheck } from './startup-check.js';
import {
  INTERRUPT_POLL_MAX_ERRORS,
  INTERRUPT_POLL_RECOVERY_BACKOFF_MS,
  INTERRUPT_POLL_WARN_EVERY,
} from './constants.js';
import type { EventLoop } from '../core/event-loop/index.js';

/** motion 专用扩展（claw daemon 整体省略此组） */
interface DaemonMotionExtensions {
  heartbeat?: Heartbeat;
  /**
   * motion 自审 watchdog 存活探针（phase 324 H4 业务、phase 444 DI 化）。
   * 装配方注入：通常 `() => isWatchdogAlive(fsFactory)` 等价语义。
   * daemon 模块不直 import watchdog 模块（M#5 单向）。
   */
  watchdogAliveProbe: () => boolean;
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
  // phase 324 H4: dedup motion 自审 watchdog audit。
  let watchdogMissingAudited = false;

  // phase 1154 r+ derive: 60s liveness 心跳（B + 心跳混合方案）
  const LIVENESS_HEARTBEAT_MS = 60_000;
  const livenessTimer = setInterval(() => {
    audit.write(
      DAEMON_AUDIT_EVENTS.LIVENESS_HEARTBEAT,
      `pid=${process.pid}`,
      `uptime_s=${Math.round(process.uptime())}`,
    );
  }, LIVENESS_HEARTBEAT_MS);
  livenessTimer.unref(); // 不阻 event loop 退出

  const stop = () => {
    stopping = true;
    stopped = true;
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

      // phase 324 H4: motion 自审 watchdog 存活、不活时 audit。
      // 仅 motion daemon 检（claw daemon 无 supervisor 自审职责）。
      // dedup：仅在 alive→dead 转折或首次观察时 audit、避免每 tick 灌日志。
      if (motion && !motion.watchdogAliveProbe()) {
        if (!watchdogMissingAudited) {
          audit.write(
            DAEMON_AUDIT_EVENTS.WATCHDOG_MISSING,
            `pid=${process.pid}`,
            `uptime_s=${Math.round(process.uptime())}`,
          );
          watchdogMissingAudited = true;
        }
      } else if (motion && watchdogMissingAudited) {
        // watchdog 回来了，重置 dedup
        watchdogMissingAudited = false;
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
  })();

  return { promise, stop };
}
