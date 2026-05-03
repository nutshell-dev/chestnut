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

import * as fsNative from 'fs';
import * as path from 'path';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import type { FileSystem } from '../foundation/fs/types.js';
import type { Runtime, StreamCallbacks } from '../core/runtime/index.js';
import type { InboxMessage } from '../types/messaging.js';
import type { StreamWriter, StreamLog } from '../foundation/stream/index.js';
import { createWatcher } from '../foundation/file-watcher/index.js';
import type { Watcher } from '../foundation/file-watcher/types.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../foundation/messaging/audit-events.js';
import { DAEMON_AUDIT_EVENTS, LOOP_ITERATION_TYPES, LOOP_INTERRUPT_CAUSES } from './audit-events.js';
import { oneLine } from '../types/utils.js';

import type { Heartbeat } from '../core/runtime/index.js';

import {
  DAEMON_FALLBACK_TIMEOUT_MS,
  INTERRUPT_RECOVERY_DELAY_MS,

  STARTUP_CHECK_COOLDOWN_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_MAX_DELAY_MS,
} from '../constants.js';
import { notifyInbox } from '../foundation/messaging/index.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../types/signals.js';
import { STATUS_SUBDIR, CONTRACT_DIR } from '../types/paths.js';

/**
 * 创建 StreamCallbacks 实现，将业务事件转为 StreamEvent 写入 StreamLog。
 * 这是装配层逻辑：将 ReAct 循环的业务事件名映射为 stream.jsonl 的事件记录。
 */
function createStreamCallbacks(sink: StreamLog): StreamCallbacks {
  return {
    onBeforeLLMCall: () => {
      sink.write({ ts: Date.now(), type: 'llm_start' });
    },
    onThinkingDelta: (delta: string) => {
      sink.write({ ts: Date.now(), type: 'thinking_delta', delta });
    },
    onTextDelta: (delta: string) => {
      sink.write({ ts: Date.now(), type: 'text_delta', delta });
    },
    onTextEnd: () => {
      sink.write({ ts: Date.now(), type: 'text_end' });
    },
    onToolCall: (name: string, toolUseId: string) => {
      sink.write({ ts: Date.now(), type: 'tool_call', name, tool_use_id: toolUseId });
    },
    onToolResult: (name: string, toolUseId: string, result: { success: boolean; content: string }, step: number, maxSteps: number) => {
      const summary = oneLine(result.content);
      sink.write({
        ts: Date.now(),
        type: 'tool_result',
        name,
        tool_use_id: toolUseId,
        success: result.success,
        summary,
        step: step + 1,
        maxSteps,
      });
    },
    onTurnStart: (sources: Array<{ text: string; type: string }>) => {
      sink.write({
        ts: Date.now(),
        type: 'turn_start',
        sources: sources.length > 0 ? sources : undefined,
      });
    },
    onTurnEnd: () => {
      sink.write({ ts: Date.now(), type: 'turn_end' });
    },
    onTurnError: (error: string) => {
      sink.write({ ts: Date.now(), type: 'turn_error', error });
    },
    onTurnInterrupted: (cause: string, message?: string) => {
      sink.write({ ts: Date.now(), type: 'turn_interrupted', cause, ...(message ? { message } : {}) });
    },
    onProviderInfo: (info: { name: string; model: string; isFallback: boolean }) => {
      sink.write({ ts: Date.now(), type: 'provider_info', ...info });
    },
    onProviderFailover: (info: { from: string; timeoutMs: number }) => {
      sink.write({ ts: Date.now(), type: 'provider_failover', ...info });
    },
    onProviderFailed: (info: { provider: string; model: string; error: string }) => {
      sink.write({ ts: Date.now(), type: 'provider_failed', ...info });
    },
  };
}

/** inbox 配置子组 */
export interface DaemonInboxConfig {
  pendingDir: string;
  fallbackTimeoutMs?: number;  // fs.watch fallback timeout (default 30000ms)
}

/** motion 专用扩展（claw daemon 整体省略此组） */
export interface DaemonMotionExtensions {
  heartbeat?: Heartbeat;
  onInboxMessages?: (messages: InboxMessage[]) => Promise<void>;  // review_request handling
}

export interface DaemonLoopOptions {
  // 核心驱动（5 必填）
  runtime: Runtime;
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
 * Wait for a new file to appear in the inbox directory, or until timeout.
 */
export function waitForInbox(
  fs: FileSystem,
  audit: AuditLog,
  inboxPendingDir: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise(resolve => {
    let watcher: Watcher | null = null;
    let settled = false;

    const done = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await watcher?.close();
      watcher = null;
      resolve();
    };

    const timer = setTimeout(() => void done(), timeoutMs);

    try {
      fs.ensureDirSync(inboxPendingDir);
      watcher = createWatcher(
        fs.resolve(inboxPendingDir),
        () => void done(),
        {
          stability: 'immediate',
          onError: (err, context) => {
            const eventType = context === 'callback'
              ? MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_CALLBACK_FAILED
              : MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED;
            audit.write(
              eventType,
              `path=${inboxPendingDir}`,
              `context=${context}`,
              `reason=${err.message}`,
            );
          },
        },
      );
    } catch {
      void done();
    }
  });
}

/**
 * Run the daemon event loop.
 * Returns a promise and a stop function.
 */
export function startDaemonLoop(options: DaemonLoopOptions): {
  promise: Promise<void>;
  stop: () => void;
} {
  const { runtime, agentDir, clawId, label, audit, inbox, motion, onBatchComplete, streamWriter } = options;
  const { pendingDir: inboxPendingDir } = inbox;
  const fallbackTimeout = inbox.fallbackTimeoutMs ?? DAEMON_FALLBACK_TIMEOUT_MS;
  const heartbeat = motion?.heartbeat;
  const onInboxMessages = motion?.onInboxMessages;
  const loopFs = new NodeFileSystem({ baseDir: path.join(agentDir, '..') });
  let stopped = false;
  let startupFired = false;

  // LLM failure retry state
  const LLM_ERROR_PATTERN = /all providers failed/i;
  let llmRetryCount = 0;
  let llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  let llmRetryPending = false; // set by catch, consumed by next iteration's try

  // 状态文件路径
  const llmRetryStateFile = path.join(agentDir, STATUS_SUBDIR, 'llm-retry-state.json');

  // 内联辅助：保存当前 retry 状态
  const saveLlmRetryState = () => {
    try {
      fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
      fsNative.writeFileSync(llmRetryStateFile, JSON.stringify({
        llmRetryCount,
        llmRetryDelayMs,
        llmRetryPending,
      }));
    } catch { /* Ignore: state persistence failure should not break the main loop */ }
  };

  // 检查 clean-stop 标记（仅 motion daemon）：intentional stop → 清零退避状态
  const isCleanStop = (() => {
    const cleanStopFile = path.join(path.dirname(agentDir), 'clean-stop');
    try {
      fsNative.accessSync(cleanStopFile);
      fsNative.unlinkSync(cleanStopFile);   // 消费标记，只生效一次
      return true;
    } catch {
      return false;
    }
  })();

  // 启动时恢复（崩溃重启继续退避；clean stop 后跳过，保持默认值）
  if (!isCleanStop) {
    try {
      const saved = JSON.parse(fsNative.readFileSync(llmRetryStateFile, 'utf-8'));
      if (typeof saved.llmRetryCount === 'number') llmRetryCount = saved.llmRetryCount;
      if (typeof saved.llmRetryDelayMs === 'number') llmRetryDelayMs = saved.llmRetryDelayMs;
      if (typeof saved.llmRetryPending === 'boolean') llmRetryPending = saved.llmRetryPending;
    } catch { /* Ignore: first start or corrupted file, use defaults */ }
  }

  const stop = () => { stopped = true; };

  const promise = (async () => {
    while (!stopped) {
      // Startup single-fire: has active contract + inbox is empty → trigger once in-process (no disk write)
      if (!startupFired) {
        startupFired = true;
        const inboxEmpty = (() => {
          try {
            return fsNative.readdirSync(inboxPendingDir).filter(f => f.endsWith('.md')).length === 0;
          } catch { /* Ignore: inbox check failure, assume not empty to be safe */ return true; }
        })();
        const hasActive = (() => {
          try {
            return fsNative.readdirSync(path.join(agentDir, CONTRACT_DIR, 'active'), { withFileTypes: true }).some(e => e.isDirectory());
          } catch { /* Ignore: contract check failure, assume no active contracts */ return false; }
        })();
        if (inboxEmpty && hasActive) {
          // Dedup: only write if no startup_check already pending (heartbeat pattern)
          const alreadyPending = (() => {
            try {
              return fsNative.readdirSync(inboxPendingDir).some(f => f.includes('_startup_check_'));
            } catch { /* Ignore: pending check failure, assume no pending startup_check */ return false; }
          })();
          // Cooldown: prevent spam from rapid daemon restarts
          const startupCheckTsFile = path.join(agentDir, STATUS_SUBDIR, 'startup_check_ts');
          const lastStartupCheckTs = (() => {
            try { return parseInt(fsNative.readFileSync(startupCheckTsFile, 'utf-8').trim(), 10); } catch { /* Ignore: timestamp read failure, use 0 (no cooldown) */ return 0; }
          })();
          const startupCheckCooledDown = Date.now() - lastStartupCheckTs >= STARTUP_CHECK_COOLDOWN_MS;

          if (!alreadyPending && startupCheckCooledDown) {
            fsNative.mkdirSync(path.join(agentDir, STATUS_SUBDIR), { recursive: true });
            fsNative.writeFileSync(startupCheckTsFile, String(Date.now()));
            notifyInbox(loopFs, {
              inboxDir: inboxPendingDir,
              type: 'startup_check',
              source: 'daemon',
              priority: 'high',
              body: '系统启动。请检查活跃契约并继续执行。',
              filenameTag: 'startup_check',
            }, audit);
          }
          // No continue — processBatch() naturally picks up the inbox file
        }
      }

      // Heartbeat check (moved into daemon loop to avoid setInterval race conditions)
      if (heartbeat?.isDue()) {
        heartbeat.fire();
      }

      let interruptPoller: ReturnType<typeof setInterval> | null = null;

      // Build wrappedCallbacks outside try so catch block can access it for retryLastTurn
      const callbacks = streamWriter ? createStreamCallbacks(streamWriter) : undefined;
      const wrappedCallbacks = callbacks
        ? { ...callbacks, onInboxMessages }
        : (onInboxMessages ? { onInboxMessages } : undefined);

      try {
        // Start polling for the interrupt file
        const interruptFile = path.join(agentDir, 'interrupt');
        let interruptErrCount = 0;
        interruptPoller = setInterval(() => {
          try {
            fsNative.unlinkSync(interruptFile);
            // Reached here: file existed and was deleted — trigger abort
            runtime.abort();
            interruptErrCount = 0;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
              // No interrupt file — normal case, reset error count
              interruptErrCount = 0;
              return;
            }
            interruptErrCount++;
            if (interruptErrCount % 5 === 1) {
              console.warn(`${label} interrupt poll error: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (interruptErrCount >= 20) {
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED, `err_count=${interruptErrCount}`, `last_err=${err instanceof Error ? err.message : String(err)}`);
              console.error(`${label} interrupt poll failed ${interruptErrCount} times, disabling`);
              clearInterval(interruptPoller!);
              interruptPoller = null;
            }
          }
        }, 200);
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
              while (more > 0 && !stopped) {
                more = await runtime.processBatch(wrappedCallbacks);
                chainTotal += more;
              }

              // AuditLog: chain reaction 完成
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_ITERATION, `type=${LOOP_ITERATION_TYPES.CHAIN}`, `injected=${injected}`, `chain_total=${chainTotal}`);

              // Turn finished (not interrupted) — reset LLM retry state
              llmRetryCount = 0;
              llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
              saveLlmRetryState();
              await onBatchComplete?.();
            } else {
              // AuditLog: empty processBatch → 走 waitForInbox
              options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_ITERATION, `type=${LOOP_ITERATION_TYPES.WAIT}`, `injected=0`);

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
          // Brief wait after interrupt to avoid immediately processing the next inbox message (e.g. heartbeat)
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT, `cause=${LOOP_INTERRUPT_CAUSES.USER_INTERRUPT}`, `recovery_delay_ms=${INTERRUPT_RECOVERY_DELAY_MS}`);
          await new Promise(resolve => setTimeout(resolve, INTERRUPT_RECOVERY_DELAY_MS));
        } else if (err instanceof PriorityInboxInterrupt) {
          // 步间中断 — 直接继续，下一轮立即处理优先消息，无需 recovery delay
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT, `cause=${LOOP_INTERRUPT_CAUSES.PRIORITY_INBOX}`, `recovery_delay_ms=0`);
        } else if (
          err instanceof Error &&
          LLM_ERROR_PATTERN.test(err.message) &&
          llmRetryCount < LLM_MAX_RETRIES
        ) {
          // Transient LLM failure — schedule retry via llmRetryPending flag
          llmRetryCount++;
          const delaySec = Math.round(llmRetryDelayMs / 1000);
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_LLM_RETRY, `attempt=${llmRetryCount}`, `max=${LLM_MAX_RETRIES}`, `delay_ms=${llmRetryDelayMs}`, `err=${err.message}`);
          console.warn(`${label} LLM error, retrying in ${delaySec}s (${llmRetryCount}/${LLM_MAX_RETRIES}): ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, llmRetryDelayMs));
          llmRetryDelayMs = Math.min(llmRetryDelayMs * 2, LLM_RETRY_MAX_DELAY_MS);
          llmRetryPending = true; // next iteration will call retryLastTurn
          saveLlmRetryState();
        } else {
          // Non-LLM error, or max retries exceeded — reset and wait
          const isLLMMaxRetry = err instanceof Error && LLM_ERROR_PATTERN.test(err.message);
          llmRetryCount = 0;
          llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
          saveLlmRetryState();
          options.audit.write(DAEMON_AUDIT_EVENTS.LOOP_FATAL, `reason=${isLLMMaxRetry ? 'max_retries_exhausted' : 'non_llm_error'}`, `err=${err instanceof Error ? err.message : String(err)}`);
          console.error(`${label} processBatch error:`, err);
          if (isLLMMaxRetry) {
            console.error(`${label} LLM max retries (${LLM_MAX_RETRIES}) exhausted: ${err instanceof Error ? err.message : String(err)}`);
          }

          await waitForInbox(loopFs, options.audit, inboxPendingDir, fallbackTimeout);
        }
      }
    }
  })();

  return { promise, stop };
}
