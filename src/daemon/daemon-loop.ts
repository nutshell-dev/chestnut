/**
 * @module L6.Daemon
 * @layer L6 进程边界（Daemon 事件循环）
 * @depends L1.FileSystem, L2.AuditLog, L2.FileWatcher, L2.Stream, L2.Messaging, L5.Runtime
 * @consumers L6.Daemon
 * @contract design/modules/l6_daemon.md
 *
 * 通用 daemon 事件循环 — motion 和 claw 共用。
 */

/**
 * Generic daemon event loop
 * Shared by both motion and claw
 */

import * as path from 'path';
import { formatErr } from "../foundation/node-utils/index.js";
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import type { IRuntimeDaemon } from '../core/runtime/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { DAEMON_AUDIT_EVENTS, LOOP_ITERATION_TYPES } from './audit-events.js';
import { createInterruptWatcher } from './interrupt-watcher.js';
import type { Watcher } from '../foundation/file-watcher/index.js';

import type { Heartbeat } from '../core/runtime/index.js';

import {
  DAEMON_FALLBACK_TIMEOUT_MS,
  INTERRUPT_POLL_MAX_ERRORS,
  INTERRUPT_POLL_RECOVERY_BACKOFF_MS,
  INTERRUPT_POLL_WARN_EVERY,
  REACT_CHAIN_MAX_ITERATIONS,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_STATE_FILE,
} from './constants.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { dispatchError } from './error-handlers.js';
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { waitForInbox } from './inbox-watcher.js';
import { shouldEmitStartupCheck } from './startup-check.js';





/** inbox 配置子组 */
export interface DaemonInboxConfig {
  pendingDir: string;
  fallbackTimeoutMs?: number;  // fs.watch fallback timeout (default 30000ms)
}

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
  // 核心驱动（5 必填）
  fsFactory: (baseDir: string) => FileSystem;
  runtime: IRuntimeDaemon;
  agentDir: string;          // agent root directory (listens for interrupt signals)
  clawId: string;            // agent identifier (kebab-case)
  label: string;             // log prefix, e.g. '[motion daemon]' or '[daemon]'
  audit: AuditLog;              // audit sink for createWatcher

  // inbox 配置（必填子组）
  inbox: DaemonInboxConfig;

  // motion 专用扩展（claw 整体省略）
  motion?: DaemonMotionExtensions;

  // 流式 / 回调（2 可选）
  streamWriter?: StreamWriter;
  onBatchComplete?: () => Promise<void>;
}


/**
 * Run the daemon event loop.
 * Returns a promise and a stop function.
 */
export function startDaemonLoop(options: DaemonLoopOptions): {
  promise: Promise<void>;
  stop: () => void;
} {
  const { fsFactory, runtime, agentDir, audit, inbox, motion, onBatchComplete, streamWriter } = options;
  const { pendingDir: inboxPendingDir } = inbox;
  const fallbackTimeout = inbox.fallbackTimeoutMs ?? DAEMON_FALLBACK_TIMEOUT_MS;
  const heartbeat = motion?.heartbeat;
  const loopFs = fsFactory(path.join(agentDir, '..'));
  const agentFs = fsFactory(agentDir);
  let stopped = false;
  let startupFired = false;
  // phase 324 H4: dedup motion 自审 watchdog audit。
  let watchdogMissingAudited = false;

  // phase 1154 r+ derive: 60s liveness 心跳（B + 心跳混合方案）
  const LIVENESS_HEARTBEAT_MS = 60_000;
  const livenessTimer = setInterval(() => {
    options.audit.write(
      DAEMON_AUDIT_EVENTS.LIVENESS_HEARTBEAT,
      `pid=${process.pid}`,
      `uptime_s=${Math.round(process.uptime())}`,
    );
  }, LIVENESS_HEARTBEAT_MS);
  livenessTimer.unref(); // 不阻 event loop 退出

  // LLM failure retry state
  let llmRetryCount = 0;
  let llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  let llmRetryPending = false; // set by catch, consumed by next iteration's try

  // 内联辅助：保存当前 retry 状态
  const saveLlmRetryState = () => {
    try {
      agentFs.ensureDirSync(STATUS_SUBDIR);
      agentFs.writeAtomicSync(path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE), JSON.stringify({
        schema_version: 1,
        llmRetryCount,
        llmRetryDelayMs,
        llmRetryPending,
      }));
    } catch (e) {
      options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_FATAL, `context=saveLlmRetryState`, `reason=${(e as Error).message}`);
    }
  };

  // 检查 clean-stop 标记（仅 motion daemon）：intentional stop → 清零退避状态
  const isCleanStop = (() => {
    try {
      if (!loopFs.existsSync('clean-stop')) return false;
      loopFs.deleteSync('clean-stop');   // 消费标记，只生效一次
      return true;
    } catch {
      return false;
    }
  })();

  // 启动时恢复（崩溃重启继续退避；clean stop 后跳过，保持默认值）
  if (!isCleanStop) {
    let raw: string | undefined;
    try {
      raw = agentFs.readSync(path.join(STATUS_SUBDIR, LLM_RETRY_STATE_FILE));
    } catch (e) {
      if (!isFileNotFound(e)) {
        options.audit.write(
          DAEMON_AUDIT_EVENTS.LLM_RETRY_STATE_LOAD_FAILED,
          `reason=read_failed`,
          `error=${formatErr(e)}`,
        );
      }
      // ENOENT = first start by-design, silent ok; others = audit emitted
      raw = undefined;
    }
    if (raw !== undefined) {
      let saved: unknown;
      try {
        saved = JSON.parse(raw);
      } catch (e) {
        options.audit.write(
          DAEMON_AUDIT_EVENTS.LLM_RETRY_STATE_LOAD_FAILED,
          `reason=parse_failed`,
          `error=${formatErr(e)}`,
        );
        saved = undefined;
      }
      if (saved !== undefined) {
        if (typeof saved !== 'object' || saved === null) {
          options.audit.write(
            DAEMON_AUDIT_EVENTS.LLM_RETRY_STATE_LOAD_FAILED,
            `reason=schema_invalid`,
            `actual=${typeof saved}`,
          );
        } else {
          const s = saved as Record<string, unknown>;
          if (s.schema_version !== 1) {
            options.audit.write(
              DAEMON_AUDIT_EVENTS.LLM_RETRY_STATE_LOAD_FAILED,
              `reason=schema_version_mismatch`,
              `actual=${String(s.schema_version)}`,
              `expected=1`,
            );
          } else if (typeof s.llmRetryCount !== 'number' ||
              typeof s.llmRetryDelayMs !== 'number' ||
              typeof s.llmRetryPending !== 'boolean') {
            options.audit.write(
              DAEMON_AUDIT_EVENTS.LLM_RETRY_STATE_LOAD_FAILED,
              `reason=field_type_mismatch`,
            );
          } else {
            llmRetryCount = s.llmRetryCount;
            llmRetryDelayMs = s.llmRetryDelayMs;
            llmRetryPending = s.llmRetryPending;
          }
        }
      }
    }
  }

  const stop = () => { stopped = true; };

  const promise = (async () => {
    while (!stopped) {
      // Startup single-fire: has active contract + inbox is empty → trigger once in-process (no disk write)
      if (!startupFired) {
        startupFired = true;
        if (shouldEmitStartupCheck(agentFs)) {
          agentFs.ensureDirSync(STATUS_SUBDIR);
          agentFs.writeAtomicSync(path.join(STATUS_SUBDIR, 'startup_check_ts'), String(Date.now()));
          notifyInbox(loopFs, {
            inboxDir: inboxPendingDir,
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
          options.audit.write(
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

      // Build wrappedCallbacks outside try so catch block can access it for retryLastTurn
      const wrappedCallbacks = streamWriter ? createStreamCallbacks(streamWriter, runtime as import('../core/runtime/index.js').Runtime) : undefined;

      try {
        // Event-driven interrupt watcher (phase 361: 替原 setInterval polling)
        let interruptErrCount = 0;
        const onInterrupt = (): void => {
          runtime.abort();
          interruptErrCount = 0;
        };
        const onInterruptError = (err: Error): void => {
          interruptErrCount++;
          // phase 123: per-WARN_EVERY audit emit (DP「不丢弃静默」)
          if (interruptErrCount % INTERRUPT_POLL_WARN_EVERY === 0) {
            options.audit.write(
              DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_ERROR,
              `error_count=${interruptErrCount}`,
              `last_error=${formatErr(err)}`,
            );
          }
          if (interruptErrCount >= INTERRUPT_POLL_MAX_ERRORS) {
            options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED, `error_count=${interruptErrCount}`, `last_error=${formatErr(err)}`);
            // silent: disable path; close 失败不阻塞 recovery setTimeout 路径
            interruptWatcher?.close().catch(() => { /* silent: disable cleanup */ });
            interruptWatcher = null;
            // phase 229: DP「中断可恢复」+ DP「系统能自己做的就自己做好」delayed retry recovery
            setTimeout(() => {
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_RECOVERY_ATTEMPT, `backoff_ms=${INTERRUPT_POLL_RECOVERY_BACKOFF_MS}`);
              interruptErrCount = 0;
              interruptWatcher = createInterruptWatcher({
                agentFs, agentDir, onInterrupt, onError: onInterruptError,
              });
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_RECOVERED);
            }, INTERRUPT_POLL_RECOVERY_BACKOFF_MS);
          }
        };

        interruptWatcher = createInterruptWatcher({
          agentFs, agentDir, onInterrupt, onError: onInterruptError,
        });

        try {
          if (llmRetryPending) {
            // Retry the last turn without draining inbox (LLM was the failure, not inbox)
            llmRetryPending = false;
            await runtime.retryLastTurn(wrappedCallbacks);
            llmRetryCount = 0;
            llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
            saveLlmRetryState();
            await onBatchComplete?.();
          } else {
            const injected = await runtime.processBatch(wrappedCallbacks);
            if (injected > 0) {
              // chain reaction: keep processing until the backlog is clear
              let more = injected;
              let chainTotal = injected;
              let chainIters = 0;
              while (more > 0 && !stopped && chainIters < REACT_CHAIN_MAX_ITERATIONS) {
                more = await runtime.processBatch(wrappedCallbacks);
                chainTotal += more;
                chainIters++;
              }

              // AuditLog: chain reaction 完成
              const chainType = chainIters >= REACT_CHAIN_MAX_ITERATIONS ? LOOP_ITERATION_TYPES.CHAIN_LIMITED : LOOP_ITERATION_TYPES.CHAIN;
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_ITERATION, `type=${chainType}`, `injected=${injected}`, `chain_total=${chainTotal}`);

              // Turn finished (not interrupted) — reset LLM retry state
              llmRetryCount = 0;
              llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
              saveLlmRetryState();
              await onBatchComplete?.();
            } else {
              // phase 1154 r+ derive: wait 是 no-op 默认态、不入 audit（显式设计决策 per DP）
              await waitForInbox(loopFs, options.audit, inboxPendingDir, fallbackTimeout);
            }
          }
        } finally {
          if (interruptWatcher) {
            // silent: cleanup path; close 失败不影响 finally 后续
            await interruptWatcher.close().catch(() => { /* silent: cleanup */ });
            interruptWatcher = null;
          }
        }
      } catch (err) {
        // Clean up the watcher
        if (interruptWatcher) {
          // silent: error path; close 失败不影响 dispatchError
          await interruptWatcher.close().catch(() => { /* silent: cleanup */ });
          interruptWatcher = null;
        }

        await dispatchError(err, {
          audit: options.audit,
          loopFs,
          llmRetry: {
            get count() { return llmRetryCount; },
            set count(v) { llmRetryCount = v; },
            get delayMs() { return llmRetryDelayMs; },
            set delayMs(v) { llmRetryDelayMs = v; },
            get pending() { return llmRetryPending; },
            set pending(v) { llmRetryPending = v; },
          },
          saveLlmRetryState,
        });
      }
    }
    clearInterval(livenessTimer);
  })();

  return { promise, stop };
}
