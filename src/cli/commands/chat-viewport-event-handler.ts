/**
 * Stream event dispatch (big switch)
 * What: handles all stream.jsonl event types and routes to appropriate UI/state updates
 * When: each event from the main or task stream reader
 * Why: event source schema changes independently of display or turn tracking logic
 */

import * as path from 'path';
import { formatErr } from "../../foundation/utils/index.js";
import stringWidth from 'string-width';
import { createDirContext } from '../../foundation/audit/index.js';
import { createStreamReader, STREAM_FILE } from '../../foundation/stream/index.js';
import { TASKS_QUEUES_RESULTS_DIR } from '../../core/async-task-system/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import type { CallerType } from '../../core/caller-types.js';
import type { StreamReader } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { TurnTracker } from './chat-viewport-types.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { ThinkingMode } from './chat-viewport-commands.js';
import type { createViewportObservability } from './chat-viewport-observability.js';
import { type TaskId, makeTaskId } from '../../core/async-task-system/types.js';
import { shortenErrorMsg } from './chat-viewport-utils.js';

/**
 * provider_attempt_failed / breaker_opened 事件 display 时 errorMsg 截断 cap。
 * < 此长度直接显示、>= 此长度截至 (cap - 3) + '...'.
 */
const PROVIDER_ATTEMPT_FAILED_ERR_DISPLAY_CHARS = 60;

/** provider_failed 事件 display 时 errorMsg 截断 cap。 */
const FALLBACK_FAILURE_ERR_DISPLAY_CHARS = 80;

export interface TaskWatch {
  callerType: CallerType;
  silent: boolean;
  fileSize: number;
  leftover: string;
  streamReader: StreamReader | null;
  lastEventMs: number;
}

/**
 * phase 31 P2.4: EventHandlerDeps 按 role 拆 ISP align。
 */

export interface TurnLifecycleRole {
  turnTracker: TurnTracker;
  mainUI: MainTurnUIController;
}

export interface DisplayRenderRole {
  appendOutput: (color: string, text: string, wrap?: boolean, hangIndent?: string) => void;
}

export interface InboxFilterRole {
  showSystemMessages: boolean;
  showContractEvents: boolean;
  label: string;
}

export interface TaskWatchRole {
  agentDir: string;
  fsFactory: (baseDir: string) => FileSystem;
  taskWatchMap: Map<string, TaskWatch>;
  handleTaskEvent: (taskId: TaskId, ev: unknown) => void;
  taskStatusBar: { addTrack(taskId: TaskId, callerType: string): void };
}

export interface ObservabilityRole {
  audit: AuditLog;
  observability: ReturnType<typeof createViewportObservability>;
}

export interface ThinkingConfigRole {
  getThinkingMode: () => ThinkingMode;
}

export type EventHandlerDeps = TurnLifecycleRole & DisplayRenderRole & InboxFilterRole & TaskWatchRole & ObservabilityRole & ThinkingConfigRole;

export function createEventHandler(deps: EventHandlerDeps) {
  return function handleEvent(event: { type: string; [key: string]: unknown }): void {
    deps.observability.recordEvent(event.type);
    switch (event.type) {
      case 'turn_start': {
        deps.turnTracker.begin();
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        const srcs = event.sources as Array<{ text: string; type: string }> | undefined;
        if (deps.showSystemMessages && srcs && srcs.length > 0) {
          // 显示所有非 user_chat 的来源（系统消息、inbox 消息等）
          const sysParts = srcs.filter(s => s.type !== 'user_chat').map(s => s.text);
          if (sysParts.length > 0) {
            deps.appendOutput('\x1b[33m', `> ${sysParts.join(' | ')}`);
          }
        }
        break;
      }

      case 'llm_start':
        deps.turnTracker.begin();
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        deps.mainUI.enterPhase('waiting_llm');
        deps.mainUI.clearPreview();
        break;

      case 'thinking_delta': {
        deps.mainUI.enterPhase('waiting_llm');   // idempotent — spinner 继续转
        const thinkingBuf = deps.mainUI.appendToThinking(event.delta as string);
        if (deps.getThinkingMode() === 'full') {
          const prefix = '⏺ ';
          const indent = ' '.repeat(stringWidth(prefix));
          const previewText = thinkingBuf
            .split('\n')
            .map((line: string, i: number) => (i === 0 ? prefix : indent) + line)
            .join('\n');
          deps.mainUI.setPreview('\x1b[2m' + previewText + '\x1b[0m');
        } else if (deps.getThinkingMode() === 'compact') {
          const snippet = thinkingBuf.replace(/\s+/g, ' ').trim().slice(-60);
          deps.mainUI.setPreview('\x1b[2m(' + snippet + ')\x1b[0m');
        }
        break;
      }

      case 'text_delta': {
        deps.mainUI.flushThinking();
        deps.mainUI.enterPhase('streaming_text');
        const streamBuf = deps.mainUI.appendToBuffer(event.delta as string);
        const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
        const indent = '  ';
        const previewText = (streamBuf + '▋')
          .split('\n')
          .map((line: string, i: number) => (i === 0 ? dotPrefix : indent) + line)
          .join('\n');
        deps.mainUI.setPreview(previewText);
        break;
      }

      case 'text_end':
        // no-op: keep cursor (▋) visible until tool_call/turn_end flushes
        break;

      case 'tool_call': {
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        const toolName = String(event.name ?? '');
        const displayName = toolName;
        deps.appendOutput('\x1b[36m', `⚙ ${displayName}`);
        deps.mainUI.enterPhase('running_tool', event.name as string);
        deps.mainUI.clearPreview();
        break;
      }

      case 'tool_result': {
        deps.mainUI.enterPhase('idle');
        const icon = event.success ? '✓' : '✗';
        const step = event.step ?? '?';
        const maxSteps = event.maxSteps ?? '?';
        deps.mainUI.clearPreview();
        deps.appendOutput('\x1b[2m', `  ${icon} [${step}/${maxSteps}] ${event.summary as string}`);
        break;
      }

      case 'turn_end':
        deps.turnTracker.end();
        // Cursor disappearance signals completion; no extra separator needed
        break;

      case 'turn_interrupted': {
        const msg = (event as Record<string, unknown>).message;
        const interruptSrc = deps.turnTracker.getInterruptSource();
        const display = typeof msg === 'string' ? msg
          : interruptSrc === 'esc' ? 'Interrupted (Esc)' : 'Interrupted';
        deps.turnTracker.interrupted();
        deps.appendOutput('\x1b[33m', display);
        break;
      }

      case 'turn_error':
        deps.turnTracker.abort();
        deps.appendOutput('\x1b[31m', `✗ Error: ${event.error as string}`);
        break;

      case 'provider_info': {
        const providerName = event.name as string;
        const providerModel = event.model as string;
        const isFallback = event.isFallback as boolean;
        const fallbackNote = isFallback ? ' \x1b[38;5;214m(fallback)\x1b[0m' : '';
        deps.appendOutput('\x1b[2m', `Model: ${providerModel} · ${providerName}${fallbackNote}`);
        break;
      }

      case 'provider_attempt_failed': {
        const providerName = event.provider as string;
        const errorClass = event.errorClass as string | undefined;
        const userActionHint = event.userActionHint as string | undefined;
        const errorMsg = event.error as string;
        // phase 1425: surface 所有非 abort 失败到用户（含 transient timeout/network）/ 用户必须可观察 primary 故障
        if (errorClass && errorClass !== 'abort') {
          const hint = userActionHint === 'rotate_api_key' ? 'rotate or update API key'
            : userActionHint === 'switch_primary' ? 'check model name or switch primary provider'
            : userActionHint === 'wait_retry_after' ? 'wait for rate-limit cooldown or switch primary'
            : userActionHint === 'check_quota' ? 'check quota or top up'
            : userActionHint === 'check_endpoint' ? 'check provider endpoint / URL config'
            : userActionHint === 'check_network' ? 'check network connectivity'
            : 'see audit log for details';
          const classLabel = errorClass === 'permanent' ? 'auth/quota/model error'
            : errorClass === 'transient' ? 'network/service unavailable'
            : errorClass === 'rate_limit' ? 'rate limited'
            : 'unknown error';
          const shortErr = typeof errorMsg === 'string' ? shortenErrorMsg(errorMsg, PROVIDER_ATTEMPT_FAILED_ERR_DISPLAY_CHARS) : errorMsg;
          deps.appendOutput('\x1b[2m', `\x1b[38;5;203m✗\x1b[0m \x1b[2m${providerName} ${classLabel} (${shortErr}) / suggestion: ${hint}\x1b[0m`);
        }
        break;
      }

      case 'breaker_opened': {
        const providerName = event.provider as string;
        const failures = event.consecutiveFailures as number | undefined;
        deps.appendOutput('\x1b[2m', `\x1b[38;5;203m⚠\x1b[0m \x1b[2m${providerName} circuit breaker opened (${failures ?? '?'} consecutive failures), temporarily using fallback. Suggestion: check primary config / network / endpoint.\x1b[0m`);
        break;
      }

      case 'fallback_switched': {
        const from = event.from as string;
        const to = event.to as string;
        const reason = event.reason as string;
        deps.appendOutput('\x1b[2m', `\x1b[38;5;214m→\x1b[0m \x1b[2mswitched from ${from} to ${to} (${reason})\x1b[0m`);
        break;
      }

      case 'provider_exhausted': {
        const providerName = event.provider as string;
        const errorMsg = event.error as string;
        const shortErr = typeof errorMsg === 'string' ? shortenErrorMsg(errorMsg, PROVIDER_ATTEMPT_FAILED_ERR_DISPLAY_CHARS) : errorMsg;
        deps.appendOutput('\x1b[2m', `\x1b[38;5;203m✗\x1b[0m \x1b[2m${providerName} exhausted retries (${shortErr})\x1b[0m`);
        break;
      }

      case 'provider_failed': {
        const providerName = event.provider as string;
        const providerModel = event.model as string;
        const errorMsg = event.error as string;
        // 截断过长的错误消息
        const shortErr = shortenErrorMsg(errorMsg, FALLBACK_FAILURE_ERR_DISPLAY_CHARS);
        deps.appendOutput('\x1b[2m', `\x1b[38;5;203m✗\x1b[0m \x1b[2m${providerModel} · ${providerName} failed: ${shortErr}\x1b[0m`);
        break;
      }

      case 'user_notify': {
        deps.mainUI.enterPhase('idle');
        deps.mainUI.clearPreview();
        const sub = event.subtype as string;
        const subtaskId = event.subtaskId as string;
        if (sub === 'contract_created') {
          const claw = (event.clawId as string) ?? '';
          if (!claw || claw === deps.label) break;  // 隐藏自己的契约通知
          const title = (event.title as string) ?? '';
          const count = (event.subtaskCount as number) ?? 0;
          if (deps.showContractEvents) deps.appendOutput('\x1b[2m', `  ✓ [contract] "${title}" created for ${claw} (${count} subtasks)`);
        } else if (sub === 'subtask_completed') {
          const claw = (event.clawId as string) ?? '';
          if (!claw || claw === deps.label) break;  // 隐藏自己的契约通知
          const completed = event.completedCount as number | undefined;
          const total = event.subtaskTotal as number | undefined;
          const progress = completed != null && total != null ? `, ${completed} of ${total}` : '';
          // phase 1405: force-accept 区分显示、让用户看见质量信号（DP「用户可观察」）
          const forceAccepted = event.force_accepted === true;
          if (deps.showContractEvents) {
            const line = forceAccepted
              ? `  ⚠ [contract] ${subtaskId} force-accepted${progress} (${claw})`
              : `  ✓ [contract] ${subtaskId} passed${progress} (${claw})`;
            deps.appendOutput('\x1b[2m', line);
          }
        } else if (sub === 'verification_failed') {
          const claw = (event.clawId as string) ?? '';
          if (!claw || claw === deps.label) break;  // 隐藏自己的契约通知
          const fb = (event.feedback as string) ?? '';
          if (deps.showContractEvents) deps.appendOutput('\x1b[2m', `  ✗ [contract] ${subtaskId} failed: ${fb} (${claw})`);
        } else if (sub === 'llm_error') {
          // llm_error 始终显示（无论来源）
          const claw = (event.clawId as string) ?? '';
          const errMsg = (event.error as string) ?? '';
          const forClaw = claw ? ` (${claw})` : '';
          deps.appendOutput('\x1b[31m', `  ✗ [llm] ${errMsg}${forClaw}`);
        } else if (sub === 'dev_warning') {
          // phase 8: dev-attention 阈值警告（informational only / 不可 motion action / 供 developer 参考）
          // 来源：cron disk-monitor / audit-size-monitor / 等
          const msg = (event.message as string) ?? '';
          deps.appendOutput('\x1b[33m', `  ⚠ [dev] ${msg} (informational only, no action)`);
        }
        break;
      }

      case 'task_started': {
        const taskId = event.taskId as string;
        const callerType = (event.callerType as string) ?? 'subagent';
        // Phase 537 — defensive guard against malformed stream events (D7+D11)
        if (
          typeof taskId !== 'string' || taskId === '' || taskId === '.' || taskId.startsWith('.') ||
          taskId.includes('/') || taskId.includes('..')
        ) {
          try {
            deps.audit.write(VIEWPORT_AUDIT_EVENTS.INVALID_TASK_ID, `taskId=${JSON.stringify(taskId)}`);
          } catch { /* audit self-failure tolerated */ }
          break;
        }
        const { fs: taskFs } = createDirContext({ fsFactory: deps.fsFactory }, path.join(deps.agentDir, TASKS_QUEUES_RESULTS_DIR, taskId));
        const taskReader = createStreamReader(taskFs, STREAM_FILE, (ev) => {
          const tw = deps.taskWatchMap.get(taskId);
          if (tw) tw.lastEventMs = Date.now();
          deps.mainUI.withScope('task', () => deps.handleTaskEvent(makeTaskId(taskId), ev));
        }, deps.audit, { persistent: true });
        try {
          // phase 1401 Bug A: 从 0 catch-up，避免漏 reader 启动前 shadow 已写的
          // task_attempt_start / turn_start / llm_start（race 23ms 内三连）。
          // 这些早期事件不到达 viewport 时 lastEventMs 不更新，stale-sweep
          // 会在长 LLM 首调 5min 后误杀 — 完整推理见 coding plan/phase1401。
          taskReader.start(0);
        } catch (err) {
          try {
            deps.audit.write(VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED, `taskId=${taskId}`, `reason=${formatErr(err)}`);
          } catch { /* audit self-failure tolerated */ }
          break;   // phase 1217 r131 C.3 fix: 不 register stale TaskWatch with failed streamReader
        }
        const tw: TaskWatch = {
          callerType: callerType as CallerType,
          silent: (event.silent as boolean) ?? false,
          fileSize: 0, leftover: '', streamReader: taskReader,
          lastEventMs: Date.now(),
        };
        deps.taskWatchMap.set(taskId, tw);
        if (!tw.silent) {
          deps.taskStatusBar.addTrack(makeTaskId(taskId), callerType);
        }
        break;
      }

      default: {
        // 未识别 event 防 silent drift / audit-only / 不 console.warn 防 TUI raw mode 渲染污染
        try {
          deps.audit.write(VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT, `type=${event.type}`);
        } catch { /* audit self-failure tolerated */ }
        break;
      }
    }
  };
}
