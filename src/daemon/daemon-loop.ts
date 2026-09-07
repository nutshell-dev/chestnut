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
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import type { Watcher, WatcherFactory } from '../foundation/file-watcher/index.js';
import type { Heartbeat } from '../core/heartbeat/index.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { hasPendingStartupCheck, shouldEmitStartupCheck } from './startup-check.js';
import {
  INTERRUPT_POLL_MAX_ERRORS,
  INTERRUPT_POLL_RECOVERY_BACKOFF_MS,
  INTERRUPT_POLL_WARN_EVERY,
} from './constants.js';
import type { EventLoop } from '../core/event-loop/index.js';

/** motion 专用扩展（claw daemon 整体省略此组） */
interface DaemonMotionExtensions {
  heartbeat?: Heartbeat;
}

/**
 * phase 1794: startup check typed delivery outcome（daemon-owned）。
 * 仅 timestamp 持久化与 inbox 投递均确认才 `fired`；任一阶段失败返回
 * `pending_retry`（stage + 原始 error 证据），下 tick 重试——不再以进程
 * boolean 作先行锁抑制重试。`not_eligible` 保留原 once-per-process 语义。
 */
export type StartupCheckOutcome =
  | { kind: 'fired'; timestampMs: number }
  | { kind: 'not_eligible' }
  | { kind: 'pending_retry'; stage: 'timestamp' | 'notify'; error: string };

export interface StartupCheckDeliveryDeps {
  agentFs: FileSystem;
  clawFs: FileSystem;
  agentDir: string;
  audit: AuditLog;
}

/**
 * phase 1794: startup check 两阶段提交（eligible → timestamp_committed → inbox_committed）。
 *
 * - timestamp 已提交但 notify 未确认时保留 tsCommittedMs：下 tick 只重试 notify，
 *   不重写 timestamp（防 cooldown 基线漂移）；重试 bypass eligibility 重评估
 *   （startup_check_ts 刚提交、cooldown 必未过，重评估会把 pending_retry 误判为 not_eligible）。
 * - notifyInbox 内部 best-effort 不抛出（INBOX_WRITE_FAILED 已由其 audit）——
 *   notify 阶段结果以 inbox owner dedup identity 做 post-condition：pending 无
 *   `_startup_check_` 文件 = 未投递 → pending_retry；已存在（含上轮写盘后抛错）→ 去重不重复发。
 *   hasPendingStartupCheck I/O 错误 fail-closed 返回 true（宁不重发、可能漏重试一拍），
 *   与 owner dedup 语义一致。
 */
export function createStartupCheckDelivery(deps: StartupCheckDeliveryDeps): {
  deliver: () => StartupCheckOutcome;
} {
  const { agentFs, clawFs, agentDir, audit } = deps;
  let tsCommittedMs: number | null = null;

  const deliver = (): StartupCheckOutcome => {
    if (tsCommittedMs === null) {
      if (!shouldEmitStartupCheck(agentFs, audit)) return { kind: 'not_eligible' };
      const tsMs = Date.now();
      try {
        agentFs.ensureDirSync(STATUS_SUBDIR);
        agentFs.writeAtomicSync(path.join(STATUS_SUBDIR, 'startup_check_ts'), String(tsMs));
      } catch (err) {
        return { kind: 'pending_retry', stage: 'timestamp', error: formatErr(err) };
      }
      tsCommittedMs = tsMs;
    }
    // dedup identity 命中（首轮 eligibility 已查 / 重试轮防重复投递）→ 直接 fired
    if (hasPendingStartupCheck(agentFs, audit)) {
      return { kind: 'fired', timestampMs: tsCommittedMs };
    }
    notifyInbox(clawFs, {
      inboxDir: path.join(agentDir, 'inbox', 'pending'),
      type: 'startup_check',
      source: 'daemon',
      priority: 'high',
      body: 'System startup. Please review active contracts and resume execution.',
    }, audit);
    // post-condition：dedup identity 确认投递（notifyInbox 不抛出、只能靠证据核实）
    if (!hasPendingStartupCheck(agentFs, audit)) {
      return { kind: 'pending_retry', stage: 'notify', error: 'startup_check pending message absent after notifyInbox' };
    }
    return { kind: 'fired', timestampMs: tsCommittedMs };
  };

  return { deliver };
}

interface DaemonLoopOptions {
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
  // phase 1794: 两阶段提交——双成功才置 fired；not_eligible 保留原 once-per-process
  // 语义（单独 latch）；pending_retry 不置任何 latch、下 tick 重试。
  let startupFired = false;
  let startupChecked = false;
  const startupDelivery = createStartupCheckDelivery({
    agentFs,
    clawFs: fsFactory(path.join(agentDir, '..')),
    agentDir,
    audit,
  });
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
      // phase 1794: Startup 两阶段投递——typed outcome；失败阶段留证据、下 tick 重试
      if (!startupFired && !startupChecked) {
        const delivery = startupDelivery.deliver();
        if (delivery.kind === 'fired') {
          startupFired = true;
        } else if (delivery.kind === 'not_eligible') {
          startupChecked = true;
        } else {
          audit.write(
            DAEMON_AUDIT_EVENTS.STARTUP_CHECK_RETRY,
            `stage=${delivery.stage}`,
            `error=${delivery.error}`,
          );
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
  })();

  return { promise, stop };
}
