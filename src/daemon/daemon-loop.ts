/**
 * @module L6.DaemonLoop
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
import { formatErr } from "../foundation/utils/index.js";
import type { FileSystem } from '../foundation/fs/types.js';
import type { IRuntimeDaemon, IRuntimeChat } from '../core/runtime/index.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { DAEMON_AUDIT_EVENTS, LOOP_ITERATION_TYPES } from './audit-events.js';

import type { Heartbeat } from '../core/runtime/index.js';

import {
  DAEMON_FALLBACK_TIMEOUT_MS,
  INTERRUPT_POLL_INTERVAL_MS,
  INTERRUPT_POLL_MAX_ERRORS,
  REACT_CHAIN_MAX_ITERATIONS,
  LLM_RETRY_INITIAL_DELAY_MS,
} from './constants.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { dispatchError } from './error-handlers.js';
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import type { ClawId } from '../foundation/paths.js';
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
}

export interface DaemonLoopOptions {
  // 核心驱动（5 必填）
  fsFactory: (baseDir: string) => FileSystem;
  runtime: IRuntimeDaemon & IRuntimeChat;
  agentDir: string;          // agent root directory (listens for interrupt signals)
  clawId: ClawId;            // agent identifier (kebab-case)
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
      agentFs.writeAtomicSync(path.join(STATUS_SUBDIR, 'llm-retry-state.json'), JSON.stringify({
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
    try {
      const saved = JSON.parse(agentFs.readSync(path.join(STATUS_SUBDIR, 'llm-retry-state.json')));
      if (typeof saved.llmRetryCount === 'number') llmRetryCount = saved.llmRetryCount;
      if (typeof saved.llmRetryDelayMs === 'number') llmRetryDelayMs = saved.llmRetryDelayMs;
      if (typeof saved.llmRetryPending === 'boolean') llmRetryPending = saved.llmRetryPending;
    } catch { /* silent: first start or corrupted file, use defaults */ }
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

      let interruptPoller: ReturnType<typeof setInterval> | null = null;

      // Build wrappedCallbacks outside try so catch block can access it for retryLastTurn
      const wrappedCallbacks = streamWriter ? createStreamCallbacks(streamWriter, runtime as import('../core/runtime/index.js').Runtime) : undefined;

      try {
        // Start polling for the interrupt file
        let interruptErrCount = 0;
        interruptPoller = setInterval(() => {
          try {
            agentFs.deleteSync('interrupt');
            // Reached here: file existed and was deleted — trigger abort
            runtime.abort();
            interruptErrCount = 0;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' || (err as NodeJS.ErrnoException)?.code === 'FS_NOT_FOUND') {
              // No interrupt file — normal case, reset error count
              interruptErrCount = 0;
              return;
            }
            interruptErrCount++;
            if (interruptErrCount >= INTERRUPT_POLL_MAX_ERRORS) {
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED, `error_count=${interruptErrCount}`, `last_error=${formatErr(err)}`);
              clearInterval(interruptPoller!);
              interruptPoller = null;
            }
          }
        }, INTERRUPT_POLL_INTERVAL_MS);
        interruptPoller.unref();

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
          if (interruptPoller) {
            clearInterval(interruptPoller);
            interruptPoller = null;
          }
        }
      } catch (err) {
        // Clean up the poller
        if (interruptPoller) {
          clearInterval(interruptPoller);
          interruptPoller = null;
        }

        await dispatchError(err, {
          audit: options.audit,
          loopFs,
          inboxPendingDir,
          fallbackTimeout,
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
