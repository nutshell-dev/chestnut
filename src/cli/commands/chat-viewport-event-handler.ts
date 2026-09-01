/**
 * Stream event dispatch (big switch)
 * What: handles all stream.jsonl event types and routes to appropriate UI/state updates
 * When: each event from the main or task stream reader
 * Why: event source schema changes independently of display or turn tracking logic
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { createDirContext } from '../../foundation/audit/index.js';
import { createStreamReader, STREAM_FILE } from '../../foundation/stream/index.js';
import { TASKS_QUEUES_RESULTS_DIR } from '../../core/async-task-system/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

import type { StreamReader } from '../../foundation/stream/index.js';
import type { CliStreamEvent } from './stream-event-types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { TurnTracker } from './chat-viewport-types.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { ThinkingMode } from './chat-viewport-commands.js';
import type { createViewportObservability } from './chat-viewport-observability.js';
import { type TaskId, makeShortTaskId, makeFullTaskId, deriveShortIdFromTaskId } from '../../core/async-task-system/index.js';
import type { DescriptorSink } from './viewport-render-descriptor.js';
import { prefixLines } from '../utils/string.js';
import { formatIsoClock } from '../utils/time.js';


export interface TaskWatch {
  taskKind: string;
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

interface DisplayRenderRole {
  sink: DescriptorSink;
}

interface InboxFilterRole {
  showSystemMessages: boolean;
  showContractEvents: boolean;
  label: string;
}

export interface TaskWatchRole {
  agentDir: string;
  fsFactory: (baseDir: string) => FileSystem;
  taskWatchMap: Map<string, TaskWatch>;
  handleTaskEvent: (taskId: TaskId, ev: unknown) => void;
  stopTaskWatch: (taskId: TaskId) => Promise<void>;
  taskStatusBar: {
    addTrack(taskId: TaskId, taskKind: string): void;
    addMigratedExec(track: { taskId: TaskId; command: string; startedAt: number }): void;
    removeMigratedExec(taskId: TaskId): void;
  };
}

interface ObservabilityRole {
  audit: AuditLog;
  observability: ReturnType<typeof createViewportObservability>;
}

export interface ThinkingConfigRole {
  getThinkingMode: () => ThinkingMode;
}

export interface PendingResolutionRole {
  resolvePending: (count: number) => void;
}

export type EventHandlerDeps = TurnLifecycleRole & DisplayRenderRole & InboxFilterRole & TaskWatchRole & ObservabilityRole & ThinkingConfigRole & PendingResolutionRole;

export function createEventHandler(deps: EventHandlerDeps) {
  // phase 1277: 连续失败序列中 ALL_FAILED 只报第一次；成功 turn（turn_end）重置。
  let allFailedReported = false;
  return function handleEvent(event: CliStreamEvent): void {
    deps.observability.recordEvent(event.type);
    switch (event.type) {
      case 'turn_start': {
        deps.turnTracker.begin();
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        deps.mainUI.enterPhase('idle');
        deps.mainUI.clearPreview();
        const srcs = event.sources;
        const userCount = srcs?.filter(s => s.type === 'user_chat' || s.type === 'user_inbox_message').length ?? 0;
        deps.resolvePending(userCount);
        if (deps.showSystemMessages && srcs && srcs.length > 0) {
          // phase 436: user_chat + user_inbox_message 都属于用户意图来源；
          // 其余来源（heartbeat、task_result、contract_* 等）才作为系统消息展示。
          const sysParts = srcs
            .filter(s => s.type !== 'user_chat' && s.type !== 'user_inbox_message')
            .map(s => s.text);
          if (sysParts.length > 0) {
            deps.sink.emit({ kind: 'text-line', color: '\x1b[33m', text: `> ${sysParts.join(' | ')}` });
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
        const thinkingBuf = deps.mainUI.appendToThinking(event.delta);
        if (deps.getThinkingMode() === 'full') {
          const prefix = '⏺ [thinking] ';
          deps.mainUI.setPreview('\x1b[2m' + prefix + thinkingBuf + '\x1b[0m');
        } else if (deps.getThinkingMode() === 'compact') {
          const snippet = thinkingBuf.replace(/\s+/g, ' ').trim().slice(-60);
          deps.mainUI.setPreview('\x1b[2m[thinking] (' + snippet + ')\x1b[0m');
        }
        break;
      }

      case 'text_delta': {
        deps.mainUI.flushThinking();
        deps.mainUI.enterPhase('streaming_text');
        const streamBuf = deps.mainUI.appendToBuffer(event.delta);
        const previewText = prefixLines(streamBuf + '▋', '⏺ ', '  ');
        deps.mainUI.setPreview('\x1b[2m' + previewText + '\x1b[0m');
        break;
      }

      case 'text_end': {
        deps.mainUI.enterPhase('streaming_text');
        const streamBuf = deps.mainUI.appendToBuffer('');
        if (!streamBuf) break;
        const clean = streamBuf.endsWith('▋') ? streamBuf.slice(0, -1) : streamBuf;
        const previewText = prefixLines(clean, '⏺ ', '  ');
        deps.mainUI.setPreview('\x1b[2m' + previewText + '\x1b[0m');
        break;
      }

      case 'send_content_delta': {
        // No flushStreaming() here: per-delta flush would commit each
        // streamed fragment as its own finished line (phase 1273). Turn-start
        // and llm-start already flush stale text residue before the reply
        // stream; the accumulated buffer is flushed once at send_content_end.
        deps.mainUI.enterPhase('streaming_text');
        const streamBuf = deps.mainUI.appendToBuffer(event.delta);
        const previewText = prefixLines(streamBuf + '▋', '➤ ', '  ');
        deps.mainUI.setPreview(previewText);
        break;
      }

      case 'send_content_end': {
        deps.mainUI.flushStreamingNormal();
        deps.mainUI.clearPreview();
        break;
      }

      case 'tool_call': {
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        const toolName = String(event.name ?? '');
        const displayName = toolName;
        deps.sink.emit({ kind: 'text-line', color: '\x1b[36m', text: `⚙ ${displayName}` });
        deps.mainUI.enterPhase('running_tool', event.name);
        deps.mainUI.clearPreview();
        break;
      }

      case 'tool_result': {
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        deps.mainUI.enterPhase('idle');
        const icon = event.success ? '✓' : '✗';
        const step = event.step ?? '?';
        const maxSteps = event.maxSteps ?? '?';
        deps.mainUI.clearPreview();
        deps.sink.emit({
          kind: 'text-line',
          color: '\x1b[2m',
          text: `  ${icon} [${step}/${maxSteps}] ${event.summary}`,
        });
        break;
      }

      case 'turn_end':
        deps.turnTracker.end();
        // Cursor disappearance signals completion; no extra separator needed
        // phase 1277: 成功 turn 重置 ALL_FAILED 去重标记（失败轮次无 turn_end）。
        allFailedReported = false;
        break;

      case 'turn_interrupted': {
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        deps.mainUI.enterPhase('idle');
        deps.mainUI.clearPreview();
        const msg = event.message;
        const interruptSrc = deps.turnTracker.getInterruptSource();
        const display = typeof msg === 'string' ? msg
          : interruptSrc === 'esc' ? 'Interrupted (Esc)' : 'Interrupted';
        deps.turnTracker.interrupted();
        deps.sink.emit({ kind: 'text-line', color: '\x1b[33m', text: display });
        break;
      }

      case 'turn_error': {
        deps.turnTracker.abort();
        const errorMsg = event.error;
        const errStr = typeof errorMsg === 'string' ? errorMsg : String(errorMsg);
        // phase 1277: 连续失败序列只报第一次 ALL_FAILED（后续轮次是重复确认，
        // 由 provider_failed + 等待行表达）。识别按 error 前缀
        // （产生端 turn_error 的 error 以 [LLM_ALL_PROVIDERS_FAILED] 开头）。
        const isAllFailed = errStr.startsWith('[LLM_ALL_PROVIDERS_FAILED]');
        if (isAllFailed && allFailedReported) break;
        if (isAllFailed) allFailedReported = true;
        deps.sink.emit({ kind: 'text-line', color: '\x1b[31m', text: `✗ Error: ${errStr}` });
        break;
      }

      case 'provider_info': {
        const providerName = event.name;
        const providerModel = event.model;
        const isFallback = event.isFallback;
        const fallbackNote = isFallback ? ' \x1b[38;5;214m(fallback)\x1b[0m' : '';
        deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: `Model: ${providerModel} · ${providerName}${fallbackNote}` });
        break;
      }

      case 'provider_attempt_failed': {
        // phase 1276: provider 内部重试推进（attempt 1/3、2/3…）不呈现给用户；
        // 渲染端静默、audit（handleEvent 开头 recordEvent）保留。用户可见的
        // provider 失败信息由 provider_failed case 承担（挂了 + 原因）。
        break;
      }

      case 'llm_retry_waiting': {
        // Phase 1268 Step D: EventLoop-owned turn retry/cooldown 调度行。
        // CLI 只渲染 owner 结构化字段，不解析 error 文本、不自行决定调度。
        const stage = event.stage;
        const action = event.action;
        // phase 1276: gated 与 scheduled 表达同一等待（scheduled 已带 resume 锚点），去重。
        if (action === 'gated') break;
        const attempt = typeof event.attempt === 'number' ? event.attempt : '?';
        const maxAttempts = typeof event.maxAttempts === 'number' ? event.maxAttempts : '?';
        const delaySec = typeof event.delayMs === 'number' ? Math.round(event.delayMs / 1000) : '?';
        const resumeClock = formatIsoClock(event.resumeAt);
        const classLabel = event.errorClass === 'rate_limit' ? 'rate-limit' : 'transient';
        // Phase 1274: 行首 ⟳（retry/cooldown 调度符号）；[时间][label] 前缀删除。
        // Phase 1276: scheduled retry 行带 resume 绝对时钟锚点（相对 in Xs + 绝对双表达，
        // 到点无动静即可判断卡住）。
        const prefix = '⟳';
        let text: string;
        if (action === 'released') {
          text = `${prefix} \x1b[2mllm ${stage ?? 'retry'} wait released (request changed)`;
        } else if (stage === 'cooldown') {
          text = `${prefix} \x1b[2m${classLabel} cooldown; probe at ${resumeClock}`;
        } else {
          text = `${prefix} \x1b[2mturn retry ${attempt}/${maxAttempts} in ${delaySec}s，resume at ${resumeClock}`;
        }
        deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text });
        break;
      }

      case 'breaker_opened': {
        // phase 1276: breaker 调度是系统内部事件，不呈现给用户；audit 保留。
        break;
      }

      case 'fallback_switched': {
        const from = event.from;
        const to = event.to;
        const reason = event.reason;
        deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: `\x1b[38;5;214m→\x1b[0m \x1b[2mswitched from ${from} to ${to} (${reason})` });
        break;
      }

      case 'provider_exhausted': {
        const providerName = event.provider;
        const errorMsg = event.error;
        const errStr = typeof errorMsg === 'string' ? errorMsg : String(errorMsg);
        deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: `\x1b[38;5;203m✗\x1b[0m \x1b[2m${providerName} exhausted retries (${errStr})` });
        break;
      }

      case 'provider_failed': {
        const providerName = event.provider;
        const providerModel = event.model;
        const errorMsg = event.error;
        const errStr = typeof errorMsg === 'string' ? errorMsg : String(errorMsg);
        deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: `\x1b[38;5;203m✗\x1b[0m \x1b[2m${providerModel} · ${providerName} failed: ${errStr}` });
        break;
      }

      case 'system_notify': {
        deps.mainUI.flushThinking();
        deps.mainUI.flushStreaming();
        deps.mainUI.enterPhase('idle');
        deps.mainUI.clearPreview();
        // system_notify 宽松契约（StreamEventMap: { subtype: string; [key: string]: unknown }）——
        // 除 subtype 外其余字段类型 unknown，统一断言为可选字段对象后访问；断言保留（不可删）
        const notify = event as {
          subtype: string;
          clawId?: string;
          subtaskId?: string;
          title?: string;
          subtaskCount?: number;
          completedCount?: number;
          subtaskTotal?: number;
          feedback?: string;
          error?: string;
          message?: string;
        };
        const sub = notify.subtype;
        const claw = notify.clawId ?? '';
        const subtaskId = notify.subtaskId;
        if (sub === 'contract_created') {
          if (!claw || claw === deps.label) break;  // 隐藏自己的契约通知
          const title = notify.title ?? '';
          const count = notify.subtaskCount ?? 0;
          if (deps.showContractEvents) deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: `  ✓ [contract] "${title}" created for ${claw} (${count} subtasks)` });
        } else if (sub === 'subtask_completed') {
          if (!claw || claw === deps.label) break;  // 隐藏自己的契约通知
          const completed = notify.completedCount;
          const total = notify.subtaskTotal;
          const progress = completed != null && total != null ? `, ${completed} of ${total}` : '';
          // phase 1405: force-accept 区分显示、让用户看见质量信号（DP「用户可观察」）
          const forceAccepted = event.force_accepted === true;
          if (deps.showContractEvents) {
            const line = forceAccepted
              ? `  ⚠ [contract] ${subtaskId} force-accepted${progress} (${claw})`
              : `  ✓ [contract] ${subtaskId} passed${progress} (${claw})`;
            deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: line });
          }
        } else if (sub === 'verification_failed') {
          if (!claw || claw === deps.label) break;  // 隐藏自己的契约通知
          const fb = notify.feedback ?? '';
          if (deps.showContractEvents) deps.sink.emit({ kind: 'text-line', color: '\x1b[2m', text: `  ✗ [contract] ${subtaskId} failed: ${fb} (${claw})` });
        } else if (sub === 'dev_warning') {
          // phase 8: dev-attention 阈值警告（informational only / 不可 motion action / 供 developer 参考）
          // 来源：cron audit-size-monitor / 等
          const msg = notify.message ?? '';
          deps.sink.emit({ kind: 'text-line', color: '\x1b[33m', text: `  ⚠ [dev] ${msg} (informational only, no action)` });
        }
        break;
      }

      case 'task_started': {
        const rawTaskId = event.taskId;
        const fullTaskId = event.fullTaskId ?? rawTaskId;
        const taskKind = event.taskKind ?? 'spawn_subagent';
        // Phase 537 — defensive guard against malformed stream events (D7+D11)
        // Phase 849: taskId is the shortId; fullTaskId is the persistence key.
        const taskId = typeof rawTaskId === 'string' && rawTaskId.length === 36
          ? deriveShortIdFromTaskId(makeFullTaskId(rawTaskId))
          : rawTaskId;
        if (
          typeof taskId !== 'string' || taskId === '' || taskId === '.' || taskId.startsWith('.') ||
          taskId.includes('/') || taskId.includes('..') ||
          typeof fullTaskId !== 'string' || fullTaskId === '' || fullTaskId.includes('/') || fullTaskId.includes('..')
        ) {
          try {
            deps.audit.write(VIEWPORT_AUDIT_EVENTS.INVALID_TASK_ID, `taskId=${JSON.stringify(taskId)}`, `fullTaskId=${JSON.stringify(fullTaskId)}`);
          } catch { /* audit self-failure tolerated */ }
          break;
        }
        // Phase 833: migrated exec tasks have no per-task stream reader; render
        // them in a dedicated viewport area instead.
        if (taskKind === 'exec_migrated') {
          deps.taskStatusBar.addMigratedExec({
            taskId: makeShortTaskId(taskId),
            command: event.command ?? 'exec',
            startedAt: event.startedAt ?? Date.now(),
          });
          break;
        }
        const basePath = path.join(deps.agentDir, TASKS_QUEUES_RESULTS_DIR, fullTaskId);
        const { fs: taskFs } = createDirContext({ fsFactory: deps.fsFactory }, basePath);
        const taskReader = createStreamReader(taskFs, STREAM_FILE, (ev) => {
          const tw = deps.taskWatchMap.get(taskId);
          if (tw) tw.lastEventMs = Date.now();
          deps.mainUI.withScope('task', () => deps.handleTaskEvent(makeShortTaskId(taskId), ev));
        }, deps.audit, { persistent: true });
        try {
          // phase 1401 Bug A: 从 0 catch-up，避免漏 reader 启动前 shadow 已写的
          // task_attempt_start / turn_start / llm_start（race 23ms 内三连）。
          // 这些早期事件不到达 viewport 时 lastEventMs 不更新，stale-sweep
          // 会在长 LLM 首调 5min 后误杀 — 完整推理见 coding plan/phase1401。
          taskReader.start(0);
        } catch (err) {
          try {
            deps.audit.write(VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED, `taskId=${taskId}`, `fullTaskId=${fullTaskId}`, `reason=${formatErr(err)}`);
          } catch { /* audit self-failure tolerated */ }
          break;   // phase 1217 r131 C.3 fix: 不 register stale TaskWatch with failed streamReader
        }
        const tw: TaskWatch = {
          taskKind,
          silent: event.silent ?? false,
          fileSize: 0, leftover: '', streamReader: taskReader,
          lastEventMs: Date.now(),
        };
        deps.taskWatchMap.set(taskId, tw);
        if (!tw.silent) {
          deps.taskStatusBar.addTrack(makeShortTaskId(taskId), taskKind);
        }
        break;
      }

      case 'task_completed': {
        const rawTaskId = event.taskId;
        if (typeof rawTaskId !== 'string' || rawTaskId === '') break;
        const taskId = rawTaskId.length === 36
          ? deriveShortIdFromTaskId(makeFullTaskId(rawTaskId))
          : rawTaskId;
        const shortTaskId = makeShortTaskId(taskId);
        deps.taskStatusBar.removeMigratedExec(shortTaskId);
        if (deps.taskWatchMap.has(shortTaskId)) {
          void deps.stopTaskWatch(shortTaskId).catch((err) => {
            deps.audit.write(
              VIEWPORT_AUDIT_EVENTS.TASK_WATCH_STOP_FAILED,
              `taskId=${shortTaskId}`,
              `reason=${formatErr(err)}`,
            );
          });
        }
        break;
      }

      // 非消费类型显式声明：保持原 default 的 UNKNOWN audit 可观测性
      case 'tool_use_input':
      case 'provider_failover':
      case 'retry_scheduled':
      case 'breaker_half_open': case 'breaker_closed':
      case 'healthcheck_failed': case 'stream_reset': case 'stream_parse_error':
      case 'tool_arg_parse_error': case 'idle_failover_triggered':
      case 'stream_idle_probe_attempted': case 'stream_idle_probe_succeeded':
      case 'context_exceeded_failover': case 'context_exceeded_throwthrough':
      case 'permanent_skip_retry':
      case 'hedge_started': case 'hedge_primary_recovered': case 'hedge_primary_post_first_chunk_failure':
      case 'hedge_fallback_committed': case 'hedge_primary_succeeded_after_race_lost':
      case 'all_providers_context_exceeded': case 'race_loser_cleaned':
      case 'sdk_client_cache_hit': case 'sdk_client_cache_miss': case 'provider_close_failed':
      case 'session_boundary':
      case 'daemon_started': case 'task_attempt_start': {
        try {
          deps.audit.write(VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT, `type=${event.type}`);
        } catch { /* audit self-failure tolerated */ }
        break;
      }

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };
}
