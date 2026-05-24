/**
 * Chat Viewport - tail stream.jsonl 并渲染 TUI
 * motion 和 claw 共用
 */

import * as path from 'path';
import { createWatcher } from '../../foundation/file-watcher/index.js';

import { createDirContext, createProcessManagerForCLI } from '../utils/factories.js';
import { isAlive } from '../../foundation/process-exec/index.js';
import { getContractCreatedMs } from '../../core/contract/index.js';
import stringWidth from 'string-width';
import { wrapLine, fitLine } from '../utils/string.js';
import { OUTPUT_LINES_CAP, CLAW_SCAN_INTERVAL_MS } from './constants.js';
import type { CallerType } from '../../foundation/tool-protocol/caller-type.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { createSystemAudit } from '../../foundation/audit/index.js';
import { createStreamReader, STREAM_FILE } from '../../foundation/stream/index.js';
import { createViewportObservability } from './chat-viewport-observability.js';
import type { StreamReader } from '../../foundation/stream/index.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import { TASKS_QUEUES_RESULTS_DIR } from '../../core/async-task-system/index.js';

import { writeUserChat } from './chat-viewport-utils.js';
import { findRecentTurnStartOffset } from '../../foundation/stream/index.js';
import { type ClawTrack, makeClawTrack, buildClawLine } from './chat-viewport-claw-line.js';
import { createMainTurnUI, type MainTurnUIDeps, type MainTurnUIController } from './main-turn-ui.js';
import { createTaskEventHandler, type TaskEventHandlerDeps, type TaskEvent } from './chat-viewport-task-events.js';
import { createTaskStatusBar, type TaskStatusBarController } from './chat-viewport-task-status-bar.js';
import { createClawManager, type ClawManager } from './chat-viewport-claw-manager.js';
import { createViewportCommands, type ViewportCommand, type ThinkingMode } from './chat-viewport-commands.js';
import { createTuiInputHandler, type ShutdownReason } from './chat-viewport-input.js';

// File-local interval / timeout constants
const INTERRUPT_CLEANUP_TIMEOUT_MS = 5000;
const CLAW_REFRESH_INTERVAL_MS = 2000;
const CLAW_PANEL_TICK_INTERVAL_MS = 1000;
const DAEMON_LIVENESS_CHECK_INTERVAL_MS = 3000;

export interface ChatViewportOptions {
  agentDir: string;   // motion dir 或 claw dir
  label: string;      // 显示名，如 'motion' 或 'claw-search'
  ensureDaemon?: () => Promise<void>;  // 调用方提供：检查 daemon 是否运行，没运行就启动
  showRecapStream?: boolean;   // 复盘子代理 stream，默认 false
  showSystemMessages?: boolean;   // system message，默认 false
  showContractEvents?: boolean;   // contract 子任务完成信息，默认 true
  trimOutputNewlines?: boolean;   // LLM 输出首尾换行清理，默认 true
  audit: AuditLog; // audit sink for createWatcher
}

export interface TurnTracker {
  begin(): void;
  end(): void;
  abort(): void;
  interrupted(): void;
  requestInterrupt(source: 'esc'): void;
  forceReset(): void;
  isActive(): boolean;
  getInterruptSource(): 'esc' | null;
  destroy(): void;
}

export async function runChatViewport(options: ChatViewportOptions): Promise<void> {
  const pm = createProcessManagerForCLI();
  // 确保 daemon 运行
  if (options.ensureDaemon) {
    await options.ensureDaemon();
  }

  const { fs } = createDirContext(options.agentDir);
  const showRecapStream = options.showRecapStream ?? false;
  const showSystemMessages = options.showSystemMessages ?? false;
  const showContractEvents = options.showContractEvents ?? true;
  const trimOutputNewlines = options.trimOutputNewlines ?? true;

  const { TUI, Text, Editor, EditorKeybindingsManager, setEditorKeybindings, ProcessTerminal } = await import('@mariozechner/pi-tui');

  // 移除 Ctrl+C 从 Editor 的 selectCancel，让 TUI listener 处理
  setEditorKeybindings(new EditorKeybindingsManager({
    selectCancel: 'escape',  // 只绑 ESC
  }));

  const streamPath = path.join(options.agentDir, STREAM_FILE);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // Editor 主题 — chat-viewport 不用 autocomplete，全部 identity 函数
  const editorTheme = {
    borderColor: (s: string) => s,
    selectList: {
      selectedPrefix: (s: string) => s,
      selectedText:   (s: string) => s,
      description:    (s: string) => s,
      scrollInfo:     (s: string) => s,
      noMatch:        (s: string) => s,
    },
  };

  // 单一输出区域（永久内容 + 流式后缀合并显示，消除组件间距）
  interface OutputLine { color: string; text: string; wrap?: boolean; hangIndent?: string; }
  const outputText = new Text(`[${options.label}] Watching daemon activity...`, 0, 0);
  const outputLines: OutputLine[] = [
    { color: '', text: `[${options.label}] Watching daemon activity...` },
  ];
  // Turn lifecycle tracker（封装 inTurn + pendingInterruptSource + escTimeoutId）
  type TurnPhase = 'idle' | 'active' | 'interrupting';
  let turnTracker: TurnTracker;


  // 状态栏追踪

  let thinkingMode: ThinkingMode = 'full';

  // --- 命令注册表 ---
  const commandRegistry = new Map<string, ViewportCommand>();
  const registerCmd = (cmd: ViewportCommand) => commandRegistry.set(cmd.name, cmd);



  const observability = createViewportObservability({ audit: options.audit });

  // 提前声明 — 防 TDZ（updateDisplay 内引用 mainUI / 早期 appendOutput 触发 updateDisplay 时 mainUI 未 init）
  let mainUI: MainTurnUIController;

  // body wrap cache：流式 preview 期间 outputLines 不变 / 复用 cached body / 避免 5000 行 wrapLine 重算
  // invalidate 时机：appendOutput（push 新行）+ outputLines splice (cap 触发) + cols 变
  let bodyCache: string | null = null;
  let bodyCacheCols = -1;
  const invalidateBodyCache = () => { bodyCache = null; };

  const updateDisplay = () => {
    const startNow = performance.now();
    const cols = process.stdout.columns ?? 80;

    // body 重算：cache miss 或 cols 变才重算
    if (bodyCache === null || bodyCacheCols !== cols) {
      bodyCache = outputLines
        .flatMap(({ color, text, wrap, hangIndent }) => {
          const lines = wrap
            ? text.split('\n').flatMap(line => wrapLine(line, cols, hangIndent))
            : [fitLine(text, cols)];
          return lines.map(line => color ? `${color}${line}\x1b[0m` : line);
        })
        .join('\n');
      bodyCacheCols = cols;
    }

    const currentStatus = mainUI ? mainUI.getStatus() : '';
    const currentPreview = mainUI ? mainUI.getPreview() : '';
    const composed = [currentStatus, currentPreview].filter(Boolean).join('\n');
    const suffixBody = composed
      ? composed.split('\n').flatMap(line => wrapLine(line, cols)).join('\n')
      : '';

    const full = suffixBody ? bodyCache + '\n' + suffixBody : bodyCache;
    outputText.setText(full);
    tui.requestRender();
    const suffixLines = suffixBody ? suffixBody.split('\n').length : 0;
    observability.recordRender({
      outputLines: outputLines.length,
      suffixLines,
      elapsedMs: performance.now() - startNow,
    });
  };

  const spawnText = new Text('', 0, 0);
  const shadowText = new Text('', 0, 0);
  const attachedClawBar = new Text('', 0, 0);

  // task-status-bar wiring
  let taskBarUpdateScheduled = false;
  const taskStatusBar = createTaskStatusBar({
    updateRender: () => {
      if (taskBarUpdateScheduled) return;
      taskBarUpdateScheduled = true;
      process.nextTick(() => {
        taskBarUpdateScheduled = false;
        const cols = process.stdout.columns ?? 80;
        spawnText.setText(taskStatusBar.renderSpawn(cols));
        shadowText.setText(taskStatusBar.renderShadow(cols));
        tui.requestRender();
      });
    },
  });

  // attachedClawBar 渲染：motion viewport 监听 N 个 claw stream / 高频 delta 同 sync block 多次 trigger updateClawPanel /
  // 每次遍历 clawTrackMap × buildClawLine 重复浪费。
  // debounce nextTick：同 tick 内多次调只在 tick 末执行 1 次 / 减少 buildClawLine 重复（pi-tui requestRender 也是 nextTick / 同步到 render）
  let updateClawPanelScheduled = false;
  const _renderClawPanel = () => {
    if (clawTrackMap.size === 0) {
      attachedClawBar.setText('');
      return;
    }
    const cols = process.stdout.columns ?? 80;
    const lines: string[] = [];
    for (const [id, t] of clawTrackMap) {
      lines.push(buildClawLine(id, t, cols));
    }
    attachedClawBar.setText(lines.join('\n'));
  };
  const updateClawPanel = () => {
    if (updateClawPanelScheduled) return;
    updateClawPanelScheduled = true;
    process.nextTick(() => {
      updateClawPanelScheduled = false;
      _renderClawPanel();
    });
  };

  // 输入组件
  const editor = new Editor(tui, editorTheme);

  const appendOutput = (color: string, text: string, wrap = false, hangIndent = '') => {
    outputLines.push({ color, text, wrap, hangIndent });
    if (outputLines.length > OUTPUT_LINES_CAP) {
      outputLines.splice(0, outputLines.length - OUTPUT_LINES_CAP);
    }
    invalidateBodyCache();   // outputLines 变 / cache 失效 / 下次 updateDisplay 重算
    updateDisplay();
  };

  mainUI = createMainTurnUI({
    appendOutput,
    updateDisplay,
    trimOutputNewlines,
    getThinkingMode: () => thinkingMode,
    audit: options.audit,
    observability,
  });

  const createTurnTracker = (deps: { mainUI: typeof mainUI }): TurnTracker => {
    let phase: TurnPhase = 'idle';
    let interruptSource: 'esc' | null = null;
    let escTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanupUI = () => {
      deps.mainUI.enterPhase('idle');
      deps.mainUI.flushThinking();
      deps.mainUI.flushStreaming();
      deps.mainUI.clearPreview();
    };

    const clearEscTimeout = () => {
      if (escTimeoutId) {
        clearTimeout(escTimeoutId);
        escTimeoutId = null;
      }
    };

    return {
      begin() {
        phase = 'active';
        interruptSource = null;   // 防跨 turn leak
      },
      end() {
        phase = 'idle';
        interruptSource = null;
        clearEscTimeout();
        cleanupUI();
      },
      abort() {
        phase = 'idle';
        interruptSource = null;
        clearEscTimeout();
        cleanupUI();
      },
      interrupted() {
        phase = 'idle';
        clearEscTimeout();
        cleanupUI();
        interruptSource = null;
      },
      requestInterrupt(source) {
        if (phase !== 'active') return;
        phase = 'interrupting';
        interruptSource = source;
        deps.mainUI.enterPhase('interrupting', 'Interrupting...');
        clearEscTimeout();
        escTimeoutId = setTimeout(() => {
          escTimeoutId = null;
          if (phase === 'interrupting') {
            phase = 'idle';
            interruptSource = null;
            cleanupUI();
          }
        }, INTERRUPT_CLEANUP_TIMEOUT_MS);
      },
      forceReset() {
        phase = 'idle';
        interruptSource = null;
        clearEscTimeout();
      },
      isActive() { return phase !== 'idle'; },
      getInterruptSource() { return interruptSource; },
      destroy() { clearEscTimeout(); },
    };
  };

  turnTracker = createTurnTracker({ mainUI });

  // 提前声明 — 因 streamReader.start(recentTurnOffset) 同步 replay 调 handleEvent
  // 而 handleEvent 引用 taskWatchMap / turnTracker / handleTaskEvent
  // 必在 handleEvent 声明前完成 init / 否则 let/const TDZ 命中

  // Task stream watching (for dispatch/spawn subagent progress)
  interface TaskWatch {
    callerType: CallerType;
    silent: boolean;
    fileSize: number;
    leftover: string;
    streamReader: StreamReader | null;
    lastEventMs: number;
  }
  const taskWatchMap = new Map<string, TaskWatch>();



  const stopTaskWatch = async (taskId: string) => {
    const tw = taskWatchMap.get(taskId);
    if (!tw) return;
    await tw.streamReader?.stop();
    taskWatchMap.delete(taskId);
  };

  const handleTaskEvent = createTaskEventHandler({
    stopTaskWatch,
    taskStatusBar,
    audit: options.audit,
  });

  // 处理一个 stream event
  const handleEvent = (event: { type: string; [key: string]: unknown }) => {
    observability.recordEvent(event.type);
    switch (event.type) {
      case 'turn_start': {
        turnTracker.begin();
        mainUI.flushThinking();
        mainUI.flushStreaming();
        const srcs = event.sources as Array<{ text: string; type: string }> | undefined;
        if (showSystemMessages && srcs && srcs.length > 0) {
          // 显示所有非 user_chat 的来源（系统消息、inbox 消息等）
          const sysParts = srcs.filter(s => s.type !== 'user_chat').map(s => s.text);
          if (sysParts.length > 0) {
            appendOutput('\x1b[33m', `> ${sysParts.join(' | ')}`);
          }
        }
        break;
      }

      case 'llm_start':
        turnTracker.begin();
        mainUI.flushThinking();
        mainUI.flushStreaming();
        mainUI.enterPhase('waiting_llm');
        mainUI.clearPreview();
        break;

      case 'thinking_delta': {
        mainUI.enterPhase('waiting_llm');   // idempotent — spinner 继续转
        const thinkingBuf = mainUI.appendToThinking(event.delta as string);
        if (thinkingMode === 'full') {
          const prefix = '⏺ ';
          const indent = ' '.repeat(stringWidth(prefix));
          const previewText = thinkingBuf
            .split('\n')
            .map((line: string, i: number) => (i === 0 ? prefix : indent) + line)
            .join('\n');
          mainUI.setPreview('\x1b[2m' + previewText + '\x1b[0m');
        } else if (thinkingMode === 'compact') {
          const snippet = thinkingBuf.replace(/\s+/g, ' ').trim().slice(-60);
          mainUI.setPreview('\x1b[2m(' + snippet + ')\x1b[0m');
        }
        break;
      }

      case 'text_delta': {
        mainUI.flushThinking();
        mainUI.enterPhase('streaming_text');
        const streamBuf = mainUI.appendToBuffer(event.delta as string);
        const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
        const indent = '  ';
        const previewText = (streamBuf + '▋')
          .split('\n')
          .map((line: string, i: number) => (i === 0 ? dotPrefix : indent) + line)
          .join('\n');
        mainUI.setPreview(previewText);
        break;
      }

      case 'text_end':
        // no-op: keep cursor (▋) visible until tool_call/turn_end flushes
        break;

      case 'tool_call': {
        mainUI.flushThinking();
        mainUI.flushStreaming();
        const toolName = String(event.name ?? '');
        const displayName = toolName;
        appendOutput('\x1b[36m', `⚙ ${displayName}`);
        mainUI.enterPhase('running_tool', event.name as string);
        mainUI.clearPreview();
        break;
      }

      case 'tool_result': {
        mainUI.enterPhase('idle');
        const icon = event.success ? '✓' : '✗';
        const step = event.step ?? '?';
        const maxSteps = event.maxSteps ?? '?';
        mainUI.clearPreview();
        appendOutput('\x1b[2m', `  ${icon} [${step}/${maxSteps}] ${event.summary as string}`);
        break;
      }

      case 'turn_end':
        turnTracker.end();
        // Cursor disappearance signals completion; no extra separator needed
        break;

      case 'turn_interrupted': {
        const msg = (event as Record<string, unknown>).message;
        const interruptSrc = turnTracker.getInterruptSource();
        const display = typeof msg === 'string' ? msg
          : interruptSrc === 'esc' ? 'Interrupted (Esc)' : 'Interrupted';
        turnTracker.interrupted();
        appendOutput('\x1b[33m', display);
        break;
      }

      case 'turn_error':
        turnTracker.abort();
        appendOutput('\x1b[31m', `✗ Error: ${event.error as string}`);
        break;

      case 'provider_info': {
        const providerName = event.name as string;
        const providerModel = event.model as string;
        const isFallback = event.isFallback as boolean;
        const fallbackNote = isFallback ? ' \x1b[38;5;214m(fallback)\x1b[0m' : '';
        appendOutput('\x1b[2m', `Model: ${providerModel} · ${providerName}${fallbackNote}`);
        break;
      }

      case 'provider_attempt_failed': {
        const providerName = event.provider as string;
        const errorClass = event.errorClass as string | undefined;
        const userActionHint = event.userActionHint as string | undefined;
        const errorMsg = event.error as string;
        if (errorClass === 'permanent') {
          const hintZh = userActionHint === 'rotate_api_key' ? '检查或更新 API key'
            : userActionHint === 'switch_primary' ? '检查 model 名或切换首选供应商'
            : userActionHint === 'wait_retry_after' ? '等限流冷却或换 primary'
            : userActionHint === 'check_quota' ? '检查配额或充值'
            : '请查看 audit log 详情';
          const classZh = errorClass === 'permanent' ? 'auth/quota/model 错'
            : errorClass === 'transient' ? '网络/服务暂时不可用'
            : errorClass === 'rate_limit' ? '触发限流'
            : errorClass === 'abort' ? '中断'
            : '未知错误';
          const shortErr = typeof errorMsg === 'string' && errorMsg.length > 60 ? errorMsg.slice(0, 57) + '...' : errorMsg;
          appendOutput('\x1b[31m', `⚠ ${providerName} ${classZh}（${shortErr}）/ 已 failover / 建议${hintZh}`);
        }
        break;
      }

      case 'provider_failed': {
        const providerName = event.provider as string;
        const providerModel = event.model as string;
        const errorMsg = event.error as string;
        // 截断过长的错误消息
        const shortErr = errorMsg.length > 80 ? errorMsg.slice(0, 77) + '...' : errorMsg;
        appendOutput('\x1b[2m', `\x1b[38;5;203m✗\x1b[0m \x1b[2m${providerModel} · ${providerName} failed: ${shortErr}\x1b[0m`);
        break;
      }

      case 'user_notify': {
        mainUI.enterPhase('idle');
        mainUI.clearPreview();
        const sub = event.subtype as string;
        const subtaskId = event.subtaskId as string;
        if (sub === 'contract_created') {
          const claw = (event.clawId as string) ?? '';
          if (!claw || claw === options.label) break;  // 隐藏自己的契约通知
          const title = (event.title as string) ?? '';
          const count = (event.subtaskCount as number) ?? 0;
          if (showContractEvents) appendOutput('\x1b[2m', `  ✓ [contract] "${title}" created for ${claw} (${count} subtasks)`);
        } else if (sub === 'subtask_completed') {
          const claw = (event.clawId as string) ?? '';
          if (!claw || claw === options.label) break;  // 隐藏自己的契约通知
          const completed = event.completedCount as number | undefined;
          const total = event.subtaskTotal as number | undefined;
          const progress = completed != null && total != null ? `, ${completed} of ${total}` : '';
          if (showContractEvents) appendOutput('\x1b[2m', `  ✓ [contract] ${subtaskId} passed${progress} (${claw})`);
        } else if (sub === 'acceptance_failed') {
          const claw = (event.clawId as string) ?? '';
          if (!claw || claw === options.label) break;  // 隐藏自己的契约通知
          const fb = (event.feedback as string) ?? '';
          if (showContractEvents) appendOutput('\x1b[2m', `  ✗ [contract] ${subtaskId} failed: ${fb} (${claw})`);
        } else if (sub === 'llm_error') {
          // llm_error 始终显示（无论来源）
          const claw = (event.clawId as string) ?? '';
          const errMsg = (event.error as string) ?? '';
          const forClaw = claw ? ` (${claw})` : '';
          appendOutput('\x1b[31m', `  ✗ [llm] ${errMsg}${forClaw}`);
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
            options.audit.write(VIEWPORT_AUDIT_EVENTS.INVALID_TASK_ID, `taskId=${JSON.stringify(taskId)}`);
          } catch { /* audit self-failure tolerated */ }
          break;
        }
        const { fs: taskFs } = createDirContext(path.join(options.agentDir, TASKS_QUEUES_RESULTS_DIR, taskId));
        const taskReader = createStreamReader(taskFs, STREAM_FILE, (ev) => {
          const tw = taskWatchMap.get(taskId);
          if (tw) tw.lastEventMs = Date.now();
          mainUI.withScope('task', () => handleTaskEvent(taskId, ev));
        }, options.audit, { persistent: true });
        taskReader.start();
        const tw: TaskWatch = {
          callerType: callerType as CallerType,
          silent: (event.silent as boolean) ?? false,
          fileSize: 0, leftover: '', streamReader: taskReader,
          lastEventMs: Date.now(),
        };
        taskWatchMap.set(taskId, tw);
        if (!tw.silent) {
          taskStatusBar.addTrack(taskId, callerType);
        }
        break;
      }

      default: {
        // 未识别 event 防 silent drift / audit-only / 不 console.warn 防 TUI raw mode 渲染污染
        try {
          options.audit.write(VIEWPORT_AUDIT_EVENTS.UNKNOWN_EVENT, `type=${event.type}`);
        } catch { /* audit self-failure tolerated */ }
        break;
      }
    }
  };

  // tail stream.jsonl
  // 启动期 backward scan 找最近 turn_start byte offset / 用该 offset 启 reader →
  // chat-viewport 启动慢于 daemon 时（PROCESS_SPAWN_CONFIRM_MS = 3000ms / daemon 50ms 已 emit turn_start + llm_start）
  // 仍能 catch-up 当前 turn 的 events（如 llm_start → spinner 启动）。
  const streamReader = createStreamReader(fs, STREAM_FILE, (ev) => mainUI.withScope('main', () => handleEvent(ev)), options.audit, { persistent: false });
  const recentTurnOffset = findRecentTurnStartOffset(fs, STREAM_FILE);
  streamReader.start(recentTurnOffset);

  // Motion viewport：各 claw 步数追踪
  const isMotion = options.label === 'motion';
  const clawsDir = isMotion ? path.join(options.agentDir, '..', CLAWS_DIR) : '';
  // NEW fs instance for clawsDir scan（motion fs baseDir=motionDir / 不接受 clawsDir 绝对路径 / 创建 dedicated clawsFs baseDir=clawsDir）
  const clawsFs = isMotion && clawsDir ? createDirContext(clawsDir).fs : fs;
  const clawTrackMap = new Map<string, ClawTrack>();
  const clawManager = createClawManager({
    fs: clawsFs, pm, audit: options.audit, isMotion, clawsDir, clawTrackMap,
    updateClawPanel,
    requestRender: () => tui.requestRender(),
  });


  // fallback 轮询（claw 刷新 + panel tick 拆独立 interval）
  const clawRefreshInterval = setInterval(() => {
    if (isMotion) clawManager.refreshAllClawStatus();
  }, CLAW_REFRESH_INTERVAL_MS);
  clawRefreshInterval.unref();

  const clawPanelTickInterval = setInterval(() => {
    if (clawTrackMap.size > 0) {
      updateClawPanel();
      tui.requestRender();
    }
  }, CLAW_PANEL_TICK_INTERVAL_MS);
  clawPanelTickInterval.unref();

  // Daemon 存活检测（每 3 秒一次）
  let daemonDead = false;
  const checkDaemonAlive = async () => {
    if (daemonDead) return;
    try {
      const stored = await pm.readPid(options.label);
      if (stored === null) return;
      if (!isAlive(stored.pid)) {
        // 进程不存在
        daemonDead = true;
        turnTracker.abort();
        appendOutput('\x1b[31m', '✗ Daemon 已停止');
        observability.recordShutdown('daemon_dead');
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[viewport] daemon liveness PID read failed: ${(e as Error).message}\n`);
      }
    }
  };
  const daemonCheckInterval = setInterval(checkDaemonAlive, DAEMON_LIVENESS_CHECK_INTERVAL_MS);
  daemonCheckInterval.unref();

  // Stale task stream sweep（5min 无 event → cleanup）
  const TASK_STALE_TIMEOUT_MS = 5 * 60 * 1000;
  const TASK_SWEEP_INTERVAL_MS = 60 * 1000;
  const taskSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [taskId, tw] of taskWatchMap) {
      if (now - tw.lastEventMs > TASK_STALE_TIMEOUT_MS) {
        void stopTaskWatch(taskId);
        try {
          options.audit.write(
            VIEWPORT_AUDIT_EVENTS.TASK_STREAM_STALE_CLEANUP,
            `taskId=${taskId}`,
            `idle_ms=${now - tw.lastEventMs}`,
          );
        } catch { /* audit self-failure tolerated */ }
      }
    }
  }, TASK_SWEEP_INTERVAL_MS);
  taskSweepInterval.unref();

  // --- 注册 slash 命令 ---
  for (const cmd of createViewportCommands({
    isMotion, clawsDir, clawTrackMap, fs,
    appendOutput, invalidateBodyCache,
    clearOutputLines: () => { outputLines.length = 0; },
    mainUI, clawManager, updateClawPanel,
    getThinkingMode: () => thinkingMode,
    setThinkingMode: (m) => { thinkingMode = m; },
    getRegistry: () => commandRegistry,
  })) {
    registerCmd(cmd);
  }

  // 输入提交处理
  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      editor.setText('');
      tui.requestRender();
      return;
    }

    if (trimmed === 'exit' || trimmed === 'quit') {
      resolveExit();
      return;
    }

    // slash 命令（仅匹配 /word 格式，/path/with/slashes 不触发）
    const cmdMatch = trimmed.match(/^\/([a-zA-Z_][\w-]*)(?:\s+(.*))?$/);
    if (cmdMatch) {
      const name = cmdMatch[1];
      const rawTail = (cmdMatch[2] ?? '').trim();
      const args = rawTail ? rawTail.split(/\s+/) : [];
      const cmd = commandRegistry.get(name);
      if (cmd) {
        try {
          cmd.execute(args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            options.audit.write(VIEWPORT_AUDIT_EVENTS.COMMAND_ERROR, `name=${name}`, `reason=${msg}`);
          } catch { /* audit self-failure tolerated */ }
          appendOutput('\x1b[31m', `[error] /${name} 执行失败：${msg}`, true);
        }
      } else {
        appendOutput('\x1b[31m', `[unknown command: /${name}]  输入 /help 查看可用命令`);
      }
      editor.setText('');
      tui.requestRender();
      return;
    }

    // 显示用户消息
    appendOutput('\x1b[32m', `> ${trimmed}`, true);
    editor.setText('');
    editor.addToHistory(trimmed);

    // 写入 inbox
    try {
      writeUserChat(options.agentDir, trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput('\x1b[31m', `[error] 消息发送失败：${msg}（请重试或检查磁盘 / 权限）`, true);
    }
    tui.requestRender();
  };

  // Ctrl+C / Ctrl+D 退出
  let resolveExit: () => void;
  const exitPromise = new Promise<void>(r => { resolveExit = r; });
  let shutdownReason: ShutdownReason = 'user_quit';

  tui.addInputListener(createTuiInputHandler({
    fs, agentDir: options.agentDir, turnTracker, mainUI,
    clearOutputLines: () => { outputLines.length = 0; },
    invalidateBodyCache,
    resolveExit: () => resolveExit(),
    setShutdownReason: (r) => { shutdownReason = r; },
  }));

  // RESIZE 监听：终端尺寸变化时重渲染
  const onResize = () => {
    updateClawPanel();
    const cols = process.stdout.columns ?? 80;
    spawnText.setText(taskStatusBar.renderSpawn(cols));
    shadowText.setText(taskStatusBar.renderShadow(cols));
    updateDisplay();
  };
  process.stdout.on('resize', onResize);

  tui.addChild(outputText);
  tui.addChild(spawnText);       // 顶层
  tui.addChild(shadowText);      // 中层
  tui.addChild(attachedClawBar); // 下层
  tui.addChild(editor);
  tui.setFocus(editor);

  // 防御层：任何未捕获异常先还原终端，防止 terminal emulator 因 raw mode 未还原而闪退
  const crashLogPath = path.join(options.agentDir, 'logs', 'chat-crash.log');
  const uncaughtHandler = (err: unknown) => {
    // sync audit emit via motion-level audit shim（process 即将 exit、必 sync）
    // fail-soft：shim 构造或 write 失败回退 stderr-only、不抛
    try {
      const shim = createSystemAudit(
        new NodeFileSystem({ baseDir: options.agentDir }),
        options.agentDir,
      );
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : '';
      shim?.write(
        CLI_AUDIT_EVENTS.CHAT_CRASH_UNCAUGHT,
        `pid=${process.pid}`,
        `error=${errMsg}`,
        stack ? `stack_head=${stack}` : '',
      );
    } catch { /* fail-soft: shim 自身失败不破坏 crash log + stderr 路径 */ }

    // 写入崩溃日志文件（terminal 关闭后仍可读）
    try {
      const stack = (err instanceof Error) ? err.stack : String(err);
      fs.appendSync(crashLogPath, `\n[${new Date().toISOString()}] uncaught:\n${stack}\n`);
    } catch { /* silent: crash log append best-effort / 已 console.error 输出 / 不阻断 exit */ }
    process.stderr.write(`[chat] uncaught error: ${err}\n`);
    try { tui.stop(); } catch { /* silent: tui.stop best-effort / already in shutdown / 不阻断 exit */ }
    // 刷新 stdout 后再退出，防止 escape sequences 被截断触发 Terminal.app crash
    process.stdout.write('', () => { process.exitCode = 1; process.exit(1); });
  };
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', uncaughtHandler);

  /** 重连时从历史 stream 初始化自身状态（仅非 motion 调用） */
  const initOwnStateFromHistory = () => {
    if (isMotion) return;
    try {
      const stat = fs.statSync(streamPath);
      if (stat.size === 0) return;
      const buf = fs.readBytesSync(streamPath, 0, stat.size);
      const lines = buf.toString('utf-8').split('\n');
      lines.pop(); // 末尾不完整行
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'turn_start')       { turnTracker.begin(); }
          else if (ev.type === 'turn_end' || ev.type === 'turn_interrupted' || ev.type === 'turn_error') {
            turnTracker.forceReset();
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      // phase 904 / audit-2026-05-16 P2 site 2: 分流 ENOENT silent vs 其他 audit emit
      const code = (err as { code?: string })?.code;
      if (code !== 'ENOENT') {
        options.audit.write(VIEWPORT_AUDIT_EVENTS.HISTORY_REPLAY_FAILED, `error=${String(err)}`, `code=${code ?? 'unknown'}`);
      }
    }
  };

  initOwnStateFromHistory();

  // 重连状态校正：tracker 标 active 但 daemon 实际不存活 / forceReset 防误触 ESC 中断
  if (turnTracker.isActive()) {
    try {
      const stored = await pm.readPid(options.label);
      if (stored === null) {
        turnTracker.forceReset();
      } else {
        if (!isAlive(stored.pid)) { turnTracker.forceReset(); }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[viewport] turn tracker PID read failed: ${(e as Error).message}\n`);
      }
      turnTracker.forceReset();
    }
  }

  tui.start();

  // Periodically rescan clawsDir — 检测新 claw 创建 + 已存在 claw 内 contract 创建
  // 为什么不用 chokidar recursive watcher：
  //   - macOS FSEvents 对 nested newly-created dirs (如 <clawsDir>/<clawId>/contract/active/<contractId>/ 深 3 层) 不稳定
  //   - chokidar awaitWriteFinish 对 dir events 行为 inconsistent
  //   - polling 每 2s 重扫 / 简洁可靠 / 与 viewport TUI 业务节奏 align（user 不会期待 < 2s 响应）
  let clawScanInterval: NodeJS.Timeout | null = null;
  if (clawsDir) {
    const rescanClawsDir = () => {
      try {
        // clawsFs baseDir = clawsDir / 用相对路径 '.' 列 clawsDir 自身
        const entries = clawsFs.listSync('.', { includeDirs: true });
        for (const e of entries) {
          if (!e.isDirectory) continue;
          const clawId = e.name;
          if (clawTrackMap.has(clawId)) continue;
          const clawDir = path.join(clawsDir, clawId);
          // getContractCreatedMs 用 clawsFs (baseDir=clawsDir) / 传相对路径 clawId
          const contractMs = getContractCreatedMs(clawsFs, clawId, options.audit);
          if (contractMs !== null) {
            const t = makeClawTrack();
            t.hasContract = true;
            t.referenceMs = contractMs;
            clawTrackMap.set(clawId, t);
            // 开 watcher
            clawManager.attachClawWatcher(clawId, path.join(clawDir, STREAM_FILE));
          }
        }
        if (clawTrackMap.size > 0) {
          updateClawPanel();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          options.audit.write(VIEWPORT_AUDIT_EVENTS.CLAWSDIR_SCAN_FAILED, `reason=${msg}`);
        } catch { /* audit self-failure tolerated */ }
      }
    };
    // 立即触发一次扫描
    clawManager.refreshAllClawStatus();
    rescanClawsDir();
    // 周期性 rescan / 每 2s 检测新 claw 与新 contract
    clawScanInterval = setInterval(rescanClawsDir, CLAW_SCAN_INTERVAL_MS);
    clawScanInterval.unref();
  }

  // 兜底：SIGINT 退出（终端未进 raw mode 时 Ctrl+C 转为 SIGINT）
  const sigintHandler = () => resolveExit();
  process.on('SIGINT', sigintHandler);
  // SIGTERM 退出（clawforum stop 发送 / 让 stop 命令能 kill viewport process）
  const sigtermHandler = () => resolveExit();
  process.on('SIGTERM', sigtermHandler);

  try {
    await exitPromise;
  } finally {
    // 清理（即使 exitPromise reject 也跑全 cleanup / 防 fd leak）
    turnTracker.destroy();
    process.stdout.off('resize', onResize);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('uncaughtException', uncaughtHandler);
    process.removeListener('unhandledRejection', uncaughtHandler);
    mainUI.enterPhase('idle');
    observability.recordShutdown(shutdownReason);
    clearInterval(clawRefreshInterval);
    clearInterval(clawPanelTickInterval);
    clearInterval(daemonCheckInterval);
    clearInterval(taskSweepInterval);
    await streamReader.stop();
    await clawManager.closeAll();
    if (clawScanInterval) clearInterval(clawScanInterval);
    await Promise.all(
      Array.from(taskWatchMap.values())
        .map(tw => tw.streamReader?.stop())
        .filter((p): p is Promise<void> => p !== undefined)
    );
    taskWatchMap.clear();
    tui.stop();
    await terminal.drainInput();
    process.stdin.pause();
  }
}

// Re-exports for backward compatibility (tests import from chat-viewport.js)
export {
  createMainTurnUI,
  type MainTurnUIDeps,
  type MainTurnUIController,
} from './main-turn-ui.js';

export {
  createTaskEventHandler,
  type TaskEventHandlerDeps,
  type TaskEvent,
} from './chat-viewport-task-events.js';

