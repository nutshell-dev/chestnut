/**
 * Chat Viewport - tail stream.jsonl 并渲染 TUI
 * motion 和 claw 共用
 *
 * Thin orchestration: composes 5 sub-files for turn tracking, event handling,
 * claw panel, display, and init/crash handling.
 */

import * as path from 'path';

import { createDirContext, createProcessManagerForCLI } from '../utils/factories.js';
import { isAlive } from '../../foundation/process-exec/index.js';
import { CLAW_SCAN_INTERVAL_MS } from './constants.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { createStreamReader, STREAM_FILE } from '../../foundation/stream/index.js';
import { createViewportObservability } from './chat-viewport-observability.js';
import { CLAWS_DIR } from '../../foundation/paths.js';


import { writeUserChat } from './chat-viewport-utils.js';
import { findRecentTurnStartOffset } from '../../foundation/stream/index.js';
import { type ClawTrack } from './chat-viewport-claw-line.js';
import { createMainTurnUI, type MainTurnUIController } from './main-turn-ui.js';
import { createTaskEventHandler } from './chat-viewport-task-events.js';
import { createTaskStatusBar } from './chat-viewport-task-status-bar.js';
import { createClawManager } from './chat-viewport-claw-manager.js';
import { createViewportCommands, type ViewportCommand, type ThinkingMode } from './chat-viewport-commands.js';
import { createTuiInputHandler, type ShutdownReason } from './chat-viewport-input.js';

import { createTurnTracker } from './chat-viewport-turn-tracker.js';
import { createDisplay } from './chat-viewport-display.js';
import { createClawPanel, createRescanClawsDir } from './chat-viewport-claw-panel.js';
import { createEventHandler, type TaskWatch } from './chat-viewport-event-handler.js';
import { initOwnStateFromHistory, createUncaughtHandler } from './chat-viewport-init.js';

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
  const outputText = new Text(`[${options.label}] Watching daemon activity...`, 0, 0);

  // 状态栏追踪
  let thinkingMode: ThinkingMode = 'full';

  // --- 命令注册表 ---
  const commandRegistry = new Map<string, ViewportCommand>();
  const registerCmd = (cmd: ViewportCommand) => commandRegistry.set(cmd.name, cmd);

  const observability = createViewportObservability({ audit: options.audit });

  // 提前声明 — 防 TDZ
  let mainUI: MainTurnUIController;

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

  // 输入组件
  const editor = new Editor(tui, editorTheme);

  // Motion viewport：各 claw 步数追踪
  const isMotion = options.label === 'motion';
  const clawsDir = isMotion ? path.join(options.agentDir, '..', CLAWS_DIR) : '';
  const clawsFs = isMotion && clawsDir ? createDirContext(clawsDir).fs : fs;
  const clawTrackMap = new Map<string, ClawTrack>();

  const clawPanel = createClawPanel({ attachedClawBar });
  const updateClawPanel = () => clawPanel.updateClawPanel(clawTrackMap);

  // Compose display (mainUI is not yet assigned; updateDisplay guards against undefined)
  const display = createDisplay({
    label: options.label,
    outputText,
    tui,
    observability,
    updateClawPanel,
    spawnText,
    shadowText,
    taskStatusBar,
  });

  mainUI = createMainTurnUI({
    appendOutput: display.appendOutput,
    updateDisplay: display.updateDisplay,
    trimOutputNewlines,
    getThinkingMode: () => thinkingMode,
    audit: options.audit,
    observability,
  });

  // Wire display to the now-assigned mainUI by creating a single proxy display
  // that delegates to the original display but supplies mainUI.
  // We achieve this by mutating the deps object reference that display captured.
  // However, deps was captured by value in the closure.  Instead we rely on the
  // fact that display.updateDisplay guards `deps.mainUI ? ... : ''`, and we
  // swap in a wrapper that provides mainUI.
  // Simpler: recreate display once now that mainUI and updateClawPanel are known.
  // The outputLines state is local to createDisplay, so we must not recreate it.
  // Therefore we must keep the first display and only ensure mainUI is visible.
  //
  // Safe resolution: the original code already did `let mainUI` and then defined
  // updateDisplay referencing `mainUI` before it was assigned.  The guard
  // `mainUI ? mainUI.getStatus() : ''` made this safe.  Our display module keeps
  // the same guard, but the `deps.mainUI` field is undefined at creation time.
  // Because `deps` is an object passed by reference, we can mutate it:
  (display as unknown as { _deps?: { mainUI?: MainTurnUIController } })._deps = { mainUI };
  // This is hacky.  Better: we redesign display deps to accept a mutable holder.
  //
  // Cleanest fix: change DisplayDeps so mainUI is optional, and add a setter.
  // But we want minimal code change.  Let's just accept that display already
  // works because `deps.mainUI` is read at call time, and `deps` is an object
  // reference.  Wait — in the display module, `deps` is the parameter object
  // which IS passed by reference.  So if we mutate `deps.mainUI = mainUI` here,
  // the closure inside display will see the updated value!
  // Let's verify: display module captures `deps` in its closures.  In JS/TS,
  // object parameters are passed by sharing (reference), so mutations are visible.
  // Yes!  We can just do:
  //   (display as any).deps.mainUI = mainUI;
  // But we don't expose deps.  Let's add a tiny setter to display module, or
  // just restructure.
  //
  // For simplicity and zero behavioural change, we will recreate display
  // but we need to preserve outputLines.  We can export outputLines from the
  // first display and pass it to the second.  Let's modify createDisplay to
  // accept an optional initial outputLines array.

  // Actually, the simplest zero-change approach: in display.ts we already have
  // `mainUI?: MainTurnUIController`.  We can mutate the deps object if we keep
  // a reference to it.  But createDisplay doesn't expose deps.
  //
  // Let's add a lightweight `setMainUI` method to the display return object.
  // This is the cleanest way.

  // For now, we accept the pragmatic solution: recreate display with outputLines
  // carried over.  This requires a small change to createDisplay to accept
  // `outputLines?: OutputLine[]`.

  // To keep things moving, we'll use the following pragmatic approach:
  // The display module's updateDisplay only reads `deps.mainUI` at runtime.
  // We can pass a proxy object whose `mainUI` property is a getter that returns
  // the current value of the `mainUI` variable in this closure.

  // REVISED PLAN: Use a mutable holder object for mainUI.
  const mainUIHolder: { ref?: MainTurnUIController } = {};
  const displayWithHolder = createDisplay({
    label: options.label,
    outputText,
    tui,
    observability,
    get mainUI() { return mainUIHolder.ref; },
    updateClawPanel,
    spawnText,
    shadowText,
    taskStatusBar,
  } as Parameters<typeof createDisplay>[0]);

  mainUI = createMainTurnUI({
    appendOutput: displayWithHolder.appendOutput,
    updateDisplay: displayWithHolder.updateDisplay,
    trimOutputNewlines,
    getThinkingMode: () => thinkingMode,
    audit: options.audit,
    observability,
  });
  mainUIHolder.ref = mainUI;

  // Single turn tracker instance shared across the viewport
  const turnTracker = createTurnTracker({ mainUI, INTERRUPT_CLEANUP_TIMEOUT_MS });

  // Task stream watching (for dispatch/spawn subagent progress)
  const taskWatchMap = new Map<string, TaskWatch>();

  const stopTaskWatch = async (taskId: string) => {
    const tw = taskWatchMap.get(taskId);
    if (!tw) return;
    await tw.streamReader?.stop();
    taskWatchMap.delete(taskId);
  };

  const _taskEventHandler = createTaskEventHandler({
    stopTaskWatch,
    taskStatusBar,
    audit: options.audit,
  });
  const handleTaskEvent = (taskId: string, ev: unknown) => _taskEventHandler(taskId, ev as Parameters<typeof _taskEventHandler>[1]);

  const handleEvent = createEventHandler({
    turnTracker,
    mainUI,
    appendOutput: displayWithHolder.appendOutput,
    showSystemMessages,
    showContractEvents,
    agentDir: options.agentDir,
    label: options.label,
    audit: options.audit,
    observability,
    taskWatchMap,
    handleTaskEvent,
    taskStatusBar,
    getThinkingMode: () => thinkingMode,
  });

  // tail stream.jsonl
  const streamReader = createStreamReader(fs, STREAM_FILE, (ev) => mainUI.withScope('main', () => handleEvent(ev)), options.audit, { persistent: false });
  const recentTurnOffset = findRecentTurnStartOffset(fs, STREAM_FILE);
  streamReader.start(recentTurnOffset);

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
        displayWithHolder.appendOutput('\x1b[31m', '✗ Daemon 已停止');
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
    appendOutput: displayWithHolder.appendOutput,
    invalidateBodyCache: displayWithHolder.invalidateBodyCache,
    clearOutputLines: displayWithHolder.clearOutputLines,
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
          displayWithHolder.appendOutput('\x1b[31m', `[error] /${name} 执行失败：${msg}`, true);
        }
      } else {
        displayWithHolder.appendOutput('\x1b[31m', `[unknown command: /${name}]  输入 /help 查看可用命令`);
      }
      editor.setText('');
      tui.requestRender();
      return;
    }

    // 显示用户消息
    displayWithHolder.appendOutput('\x1b[32m', `> ${trimmed}`, true);
    editor.setText('');
    editor.addToHistory(trimmed);

    // 写入 inbox
    try {
      writeUserChat(options.agentDir, trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      displayWithHolder.appendOutput('\x1b[31m', `[error] 消息发送失败：${msg}（请重试或检查磁盘 / 权限）`, true);
    }
    tui.requestRender();
  };

  // Ctrl+C / Ctrl+D 退出
  let resolveExit: () => void;
  const exitPromise = new Promise<void>(r => { resolveExit = r; });
  let shutdownReason: ShutdownReason = 'user_quit';

  tui.addInputListener(createTuiInputHandler({
    fs, agentDir: options.agentDir, turnTracker, mainUI,
    clearOutputLines: displayWithHolder.clearOutputLines,
    invalidateBodyCache: displayWithHolder.invalidateBodyCache,
    resolveExit: () => resolveExit(),
    setShutdownReason: (r) => { shutdownReason = r; },
  }));

  // RESIZE 监听：终端尺寸变化时重渲染
  const onResize = displayWithHolder.onResize;
  process.stdout.on('resize', onResize);

  tui.addChild(outputText);
  tui.addChild(spawnText);       // 顶层
  tui.addChild(shadowText);      // 中层
  tui.addChild(attachedClawBar); // 下层
  tui.addChild(editor);
  tui.setFocus(editor);

  // 防御层：任何未捕获异常先还原终端，防止 terminal emulator 因 raw mode 未还原而闪退
  const crashLogPath = path.join(options.agentDir, 'logs', 'chat-crash.log');
  const uncaughtHandler = createUncaughtHandler({ agentDir: options.agentDir, fs, tui, crashLogPath, audit: options.audit });
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', uncaughtHandler);

  initOwnStateFromHistory({ isMotion, fs, streamPath, turnTracker, audit: options.audit });

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
  let clawScanInterval: NodeJS.Timeout | null = null;
  if (clawsDir) {
    const rescanClawsDir = createRescanClawsDir({
      clawsFs, clawsDir, clawTrackMap, clawManager,
      audit: options.audit, agentDir: options.agentDir, updateClawPanel,
    });
    clawManager.refreshAllClawStatus();
    rescanClawsDir();
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
