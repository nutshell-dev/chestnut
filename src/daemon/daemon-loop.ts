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
import type { InboxMessage } from '../foundation/messaging/types.js';
import type { StreamWriter } from '../foundation/stream/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { DAEMON_AUDIT_EVENTS, LOOP_ITERATION_TYPES, LOOP_INTERRUPT_CAUSES } from './audit-events.js';

import type { Heartbeat } from '../core/runtime/index.js';

import {
  DAEMON_FALLBACK_TIMEOUT_MS,
  INTERRUPT_RECOVERY_DELAY_MS,
  INTERRUPT_POLL_INTERVAL_MS,
  INTERRUPT_POLL_MAX_ERRORS,
  REACT_CHAIN_MAX_ITERATIONS,
  STARTUP_CHECK_COOLDOWN_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_MAX_DELAY_MS,
} from './constants.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../core/signals.js';
import { LLMAllProvidersFailedError } from '../foundation/llm-orchestrator/index.js';
import { CONTRACT_DIR } from '../core/contract/index.js';
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import { INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import type { ClawId } from '../foundation/identity/index.js';
import { createStreamCallbacks } from './stream-callbacks.js';
import { waitForInbox } from './inbox-watcher.js';





/** inbox 配置子组 */
export interface DaemonInboxConfig {
  pendingDir: string;
  fallbackTimeoutMs?: number;  // fs.watch fallback timeout (default 30000ms)
}

/** motion 专用扩展（claw daemon 整体省略此组） */
interface DaemonMotionExtensions {
  heartbeat?: Heartbeat;
  onInboxMessages?: (messages: InboxMessage[]) => Promise<void>;  // review_request handling
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
  const onInboxMessages = motion?.onInboxMessages;
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
        const inboxEmpty = (() => {
          try {
            return agentFs.listSync(INBOX_PENDING_DIR).filter(e => e.name.endsWith('.md')).length === 0;
          } catch { /* Ignore: inbox check failure, assume not empty to be safe */ return true; }
        })();
        const hasActive = (() => {
          try {
            return agentFs.listSync(path.join(CONTRACT_DIR, 'active'), { includeDirs: true }).some(e => e.isDirectory);
          } catch { /* Ignore: contract check failure, assume no active contracts */ return false; }
        })();
        if (inboxEmpty && hasActive) {
          // Dedup: only write if no startup_check already pending (heartbeat pattern)
          const alreadyPending = (() => {
            try {
              return agentFs.listSync(INBOX_PENDING_DIR).map(e => e.name).some(f => f.includes('_startup_check_'));
            } catch { /* Ignore: pending check failure, assume no pending startup_check */ return false; }
          })();
          // Cooldown: prevent spam from rapid daemon restarts
          const startupCheckCooledDown = (() => {
            try {
              const raw = agentFs.readSync(path.join(STATUS_SUBDIR, 'startup_check_ts')).trim();
              const ts = parseInt(raw, 10);
              if (isNaN(ts) || ts < 0) {
                // corrupt — treat as cooled down (remove file)
                agentFs.deleteSync(path.join(STATUS_SUBDIR, 'startup_check_ts'));
                return true;
              }
              return Date.now() - ts >= STARTUP_CHECK_COOLDOWN_MS;
            } catch { /* Ignore: timestamp read failure, use 0 (no cooldown) */ return true; }
          })();

          if (!alreadyPending && startupCheckCooledDown) {
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
          // No continue — processBatch() naturally picks up the inbox file
        }
      }

      // Heartbeat check (moved into daemon loop to avoid setInterval race conditions)
      if (heartbeat?.isDue()) {
        await heartbeat.fire();
      }

      let interruptPoller: ReturnType<typeof setInterval> | null = null;

      // Build wrappedCallbacks outside try so catch block can access it for retryLastTurn
      const callbacks = streamWriter ? createStreamCallbacks(streamWriter, options.audit, runtime as import('../core/runtime/index.js').Runtime) : undefined;
      const wrappedCallbacks = callbacks
        ? { ...callbacks, onInboxMessages }
        : (onInboxMessages ? { onInboxMessages } : undefined);

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

        // Distinguish system idle timeout, user interrupts from genuine errors
        if (err instanceof IdleTimeoutSignal) {
          // System idle timeout — turn_interrupted already written by processBatch/retryLastTurn via callbacks
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT, `cause=${LOOP_INTERRUPT_CAUSES.IDLE_TIMEOUT}`, `recovery_delay_ms=${INTERRUPT_RECOVERY_DELAY_MS}`);
          await new Promise(resolve => setTimeout(resolve, INTERRUPT_RECOVERY_DELAY_MS));
        } else if (err instanceof UserInterrupt) {
          // User interrupt — turn_interrupted already written by processBatch/retryLastTurn via callbacks
          // Wait for NEW user input before continuing; don't re-process the interrupted message.
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT, `cause=${LOOP_INTERRUPT_CAUSES.USER_INTERRUPT}`);
          await waitForInbox(loopFs, options.audit, inboxPendingDir, fallbackTimeout);
        } else if (err instanceof PriorityInboxInterrupt) {
          // 步间中断 — 直接继续，下一轮立即处理优先消息，无需 recovery delay
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT, `cause=${LOOP_INTERRUPT_CAUSES.PRIORITY_INBOX}`, `recovery_delay_ms=0`);
        } else if (
          err instanceof LLMAllProvidersFailedError &&
          llmRetryCount < LLM_MAX_RETRIES
        ) {
          // Transient LLM failure — schedule retry via llmRetryPending flag
          llmRetryCount++;
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_LLM_RETRY, `attempt=${llmRetryCount}`, `max=${LLM_MAX_RETRIES}`, `delay_ms=${llmRetryDelayMs}`, `error=${err.message}`);
          await new Promise(resolve => setTimeout(resolve, llmRetryDelayMs));
          llmRetryDelayMs = Math.min(llmRetryDelayMs * 2, LLM_RETRY_MAX_DELAY_MS);
          llmRetryPending = true; // next iteration will call retryLastTurn
          saveLlmRetryState();
        } else {
          // Non-LLM error, or max retries exceeded — reset and wait
          const isLLMMaxRetry = err instanceof LLMAllProvidersFailedError;
          llmRetryCount = 0;
          llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
          saveLlmRetryState();
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_FATAL, `reason=${isLLMMaxRetry ? 'max_retries_exhausted' : 'non_llm_error'}`, `error=${formatErr(err)}`);
          if (isLLMMaxRetry) {
            // LLM max retries exhausted — already audited as LOOP_FATAL above
          }

          await waitForInbox(loopFs, options.audit, inboxPendingDir, fallbackTimeout);
        }
      }
    }
    clearInterval(livenessTimer);
  })();

  return { promise, stop };
}
