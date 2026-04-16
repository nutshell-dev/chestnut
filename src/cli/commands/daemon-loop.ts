/**
 * Generic daemon event loop
 * Shared by both motion and claw
 */

import * as fsNative from 'fs';
import * as path from 'path';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import type { ClawRuntime, InboxMessageInfo, StreamCallbacks } from '../../core/runtime.js';
import type { StreamWriter, StreamSink } from '../../foundation/stream/index.js';
import { oneLine } from '../../foundation/utils/string.js';

import type { Heartbeat } from '../../core/heartbeat.js';
import { scanClawOutboxes, type ClawOutboxInfo } from '../../foundation/messaging/index.js';
import { ProcessManager } from '../../foundation/process-manager/index.js';
import {
  DAEMON_FALLBACK_TIMEOUT_MS,
  INTERRUPT_RECOVERY_DELAY_MS,
  OUTBOX_NOTIFY_COOLDOWN_MS,
  STARTUP_CHECK_COOLDOWN_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_MAX_DELAY_MS,
} from '../../constants.js';
import { notifyInbox, notifyStream } from '../../utils/notify.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../../types/signals.js';

/**
 * 创建 StreamCallbacks 实现，将业务事件转为 StreamEvent 写入 StreamSink。
 * 这是装配层逻辑：将 ReAct 循环的业务事件名映射为 stream.jsonl 的事件记录。
 */
function createStreamCallbacks(sink: StreamSink): StreamCallbacks {
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

/**
 * Compose the outbox notification sent to motion's inbox.
 * Embeds daemon/contract status per claw so motion can decide action
 * (drain vs restart vs escalate) without a separate probe call.
 */
function formatOutboxNotification(infos: ClawOutboxInfo[]): string {
  const lines = infos.map((info) => {
    const { clawId, count, daemon, contract } = info;
    const drain = `\`clawforum claw outbox ${clawId} --limit ${count}\``;
    if (daemon === 'running') {
      // 正常情况：daemon 在，读一批就好
      return `- "${clawId}" 有 ${count} 条未读（daemon=running, contract=${contract}）。查看：${drain}`;
    }
    if (daemon === 'stopped' && contract === 'none') {
      // daemon 不在、无契约：claw 可能已废弃，drain 即可消除通知；如确认弃用需用户授权清理目录
      return `- "${clawId}" 有 ${count} 条积压（daemon=stopped, contract=none，claw 可能已废弃）。一次清空：${drain}`;
    }
    if (daemon === 'stopped') {
      // daemon 不在但有契约：claw 崩溃了，先决策重启还是 drain
      return `- "${clawId}" 有 ${count} 条积压（daemon=stopped, contract=${contract}，claw 异常退出）。重启：\`clawforum claw daemon ${clawId}\`；或 drain：${drain}`;
    }
    return `- "${clawId}" 有 ${count} 条未读（daemon=unknown, contract=${contract}）。查看：${drain}`;
  });
  return `有 ${infos.length} 个 claw 有未读消息：\n${lines.join('\n')}`;
}

export interface DaemonLoopOptions {
  runtime: ClawRuntime;
  agentDir: string;                      // agent root directory, used to listen for interrupt signals
  clawId: string;                        // agent identifier (kebab-case)
  inboxPendingDir: string;
  label: string;                         // log prefix, e.g. '[motion daemon]' or '[daemon]'
  onBatchComplete?: () => Promise<void>; // callback invoked after a chain reaction finishes
  fallbackTimeoutMs?: number;            // fs.watch fallback timeout (default 30000ms)
  streamWriter?: StreamWriter;           // streaming event writer
  isMotion?: boolean;                    // true = motion daemon（扫描 claw outbox、检查 clean-stop）
  heartbeat?: Heartbeat;                 // heartbeat instance (motion only)
  notifyMotionDir?: string;             // if set (claw only), notify motion on LLM max-retry failure
  onInboxMessages?: (infos: InboxMessageInfo[]) => Promise<void>;  // for review_request handling (motion only)
}

/**
 * Wait for a new file to appear in the inbox directory, or until timeout.
 */
export function waitForInbox(inboxPendingDir: string, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let watcher: ReturnType<typeof fsNative.watch> | null = null;
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      watcher = null;
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);

    try {
      fsNative.mkdirSync(inboxPendingDir, { recursive: true });
      watcher = fsNative.watch(inboxPendingDir, done);
      watcher.on('error', done);
    } catch {
      done();
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
  const { runtime, agentDir, clawId, inboxPendingDir, label, onBatchComplete, streamWriter, notifyMotionDir } = options;
  const fallbackTimeout = options.fallbackTimeoutMs ?? DAEMON_FALLBACK_TIMEOUT_MS;
  const loopFs = new NodeFileSystem({ baseDir: path.join(agentDir, '..'), enforcePermissions: false });
  let stopped = false;
  let startupFired = false;
  let lastOutboxNotifyTs = 0;

  // LLM failure retry state
  const LLM_ERROR_PATTERN = /all providers failed/i;
  let llmRetryCount = 0;
  let llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
  let llmRetryPending = false; // set by catch, consumed by next iteration's try

  // 状态文件路径
  const llmRetryStateFile = path.join(agentDir, 'status', 'llm-retry-state.json');

  // 内联辅助：保存当前 retry 状态
  const saveLlmRetryState = () => {
    try {
      fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
      fsNative.writeFileSync(llmRetryStateFile, JSON.stringify({
        llmRetryCount,
        llmRetryDelayMs,
        llmRetryPending,
      }));
    } catch { /* Ignore: state persistence failure should not break the main loop */ }
  };

  // 检查 clean-stop 标记（仅 motion daemon）：intentional stop → 清零退避状态
  const isCleanStop = (() => {
    if (!options.isMotion) return false;   // claw daemon，不检查
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
            return fsNative.readdirSync(path.join(agentDir, 'contract', 'active'), { withFileTypes: true }).some(e => e.isDirectory());
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
          const startupCheckTsFile = path.join(agentDir, 'status', 'startup_check_ts');
          const lastStartupCheckTs = (() => {
            try { return parseInt(fsNative.readFileSync(startupCheckTsFile, 'utf-8').trim(), 10); } catch { /* Ignore: timestamp read failure, use 0 (no cooldown) */ return 0; }
          })();
          const startupCheckCooledDown = Date.now() - lastStartupCheckTs >= STARTUP_CHECK_COOLDOWN_MS;

          if (!alreadyPending && startupCheckCooledDown) {
            fsNative.mkdirSync(path.join(agentDir, 'status'), { recursive: true });
            fsNative.writeFileSync(startupCheckTsFile, String(Date.now()));
            notifyInbox(loopFs, {
              inboxDir: inboxPendingDir,
              type: 'startup_check',
              source: 'daemon',
              priority: 'high',
              body: '系统启动。请检查活跃契约并继续执行。',
              filenameTag: 'startup_check',
            });
          }
          // No continue — processBatch() naturally picks up the inbox file
        }
      }

      // Heartbeat check (moved into daemon loop to avoid setInterval race conditions)
      if (options.heartbeat?.isDue()) {
        options.heartbeat.fire();
      }

      // motion: scan claw outboxes for unread messages
      if (options.isMotion) {
        const baseDir = path.join(agentDir, '..');
        const outboxInfos = await scanClawOutboxes(loopFs, baseDir, new ProcessManager(loopFs, baseDir));
        if (outboxInfos !== null) {
          if (Date.now() - lastOutboxNotifyTs >= OUTBOX_NOTIFY_COOLDOWN_MS) {
            lastOutboxNotifyTs = Date.now();
            const body = formatOutboxNotification(outboxInfos);
            notifyInbox(loopFs, {
              inboxDir: inboxPendingDir,
              type: 'claw_outbox',
              source: 'system',
              priority: 'normal',
              body,
              filenameTag: 'claw_outbox',
              dedupByType: true,
            }, label);
          }
        } else {
          lastOutboxNotifyTs = 0;  // outbox 已清空，重置静默期
        }
      }

      let interruptPoller: ReturnType<typeof setInterval> | null = null;

      // Build wrappedCallbacks outside try so catch block can access it for retryLastTurn
      const callbacks = streamWriter ? createStreamCallbacks(streamWriter) : undefined;
      const wrappedCallbacks = callbacks
        ? { ...callbacks, onInboxMessages: options.onInboxMessages }
        : (options.onInboxMessages ? { onInboxMessages: options.onInboxMessages } : undefined);

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
              console.error(`${label} interrupt poll failed ${interruptErrCount} times, disabling`);
              clearInterval(interruptPoller!);
              interruptPoller = null;
            }
          }
        }, 200);

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
              while (more > 0 && !stopped) {
                more = await runtime.processBatch(wrappedCallbacks);
              }

              // Turn finished (not interrupted) — reset LLM retry state
              llmRetryCount = 0;
              llmRetryDelayMs = LLM_RETRY_INITIAL_DELAY_MS;
              saveLlmRetryState();
              await onBatchComplete?.();
            } else {
              await waitForInbox(inboxPendingDir, fallbackTimeout);
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
          await new Promise(resolve => setTimeout(resolve, INTERRUPT_RECOVERY_DELAY_MS));
        } else if (err instanceof UserInterrupt) {
          // User interrupt — turn_interrupted already written by processBatch/retryLastTurn via callbacks
          // Brief wait after interrupt to avoid immediately processing the next inbox message (e.g. heartbeat)
          await new Promise(resolve => setTimeout(resolve, INTERRUPT_RECOVERY_DELAY_MS));
        } else if (err instanceof PriorityInboxInterrupt) {
          // 步间中断 — 直接继续，下一轮立即处理优先消息，无需 recovery delay
        } else if (
          err instanceof Error &&
          LLM_ERROR_PATTERN.test(err.message) &&
          llmRetryCount < LLM_MAX_RETRIES
        ) {
          // Transient LLM failure — schedule retry via llmRetryPending flag
          llmRetryCount++;
          const delaySec = Math.round(llmRetryDelayMs / 1000);
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
          console.error(`${label} processBatch error:`, err);
          // Notify motion when LLM max retries exhausted (claw only)
           if (isLLMMaxRetry && notifyMotionDir) {
             const errMsg = err instanceof Error ? err.message : String(err);
             const line = JSON.stringify({ ts: Date.now(), type: 'user_notify', subtype: 'llm_error', clawId, error: errMsg }) + '\n';
             notifyStream(path.join(notifyMotionDir, 'stream.jsonl'), line, label);
             notifyInbox(loopFs, {
               inboxDir: path.join(notifyMotionDir, 'inbox', 'pending'),
               type: 'watchdog_claw_llm_error',
               source: clawId,
               priority: 'high',
               body: `Claw ${clawId} LLM error after ${LLM_MAX_RETRIES} retries: ${errMsg}`,
               idPrefix: 'llm-error',
             }, label);
           }

          await waitForInbox(inboxPendingDir, fallbackTimeout);
        }
      }
    }
  })();

  return { promise, stop };
}
