/**
 * Chat Viewport - tail stream.jsonl 并渲染 TUI
 * motion 和 claw 共用
 *
 * Thin orchestration: composes 5 sub-files for turn tracking, event handling,
 * claw panel, display, and init/crash handling.
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";

import { createDirContext } from '../../foundation/audit/index.js';
import { createProcessManagerForCLI } from '../../foundation/process-manager/index.js';
import { isAlive } from '../../foundation/process-exec/index.js';
import { createWatcher, type Watcher } from '../../foundation/file-watcher/index.js';
import { createDaemonLivenessMonitor } from './chat-viewport-daemon-liveness.js';
import { DEFAULT_TERMINAL_WIDTH } from '../utils/constants.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { createStreamReader, STREAM_FILE } from '../../foundation/stream/index.js';
import { createViewportObservability } from './chat-viewport-observability.js';
import { CLAWS_DIR } from '../../core/claw-topology/claw-instance-paths.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID, createClawTopology } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';


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
import { type TaskId, makeTaskId } from '../../core/async-task-system/types.js';


/**
 * Interrupt 信号触发后 cleanup 总 budget（ms）.
 * Derivation: 5s 给 async shutdown（stream stop + audit flush + fs sync）足够时长 /
 * < user-perceptible hard kill delay (≈ 10s) / 平衡 graceful 与 force exit.
 */
const INTERRUPT_CLEANUP_TIMEOUT_MS = 5000;

/** chat-viewport 命令进程 crash log 文件（logs/ multi-owner subdir 内 cli/chat-viewport own 子树）*/
const CHAT_CRASH_LOG_FILE = 'logs/chat-crash.log';

/**
 * phase 31 P2.4: ChatViewportOptions 按 role 拆 ISP align。
 */

export interface ViewportIdentity {
  agentDir: string;   // motion dir 或 claw dir
  label: string;      // 显示名，如 'motion' 或 'claw-search'
}

export interface ViewportDisplayOptions {
  showRecapStream?: boolean;   // 复盘子代理 stream，默认 false
  showSystemMessages?: boolean;   // system message，默认 false
  showContractEvents?: boolean;   // contract 子任务完成信息，默认 true
  trimOutputNewlines?: boolean;   // LLM 输出首尾换行清理，默认 true
  /** phase 142: 用户输入超此字符数 → 落盘 inbox/attachments/。默认 EXEC_MAX_OUTPUT (2000)。 */
  userInputInlineMaxChars?: number;
}

export interface ViewportLifecycle {
  ensureDaemon?: () => Promise<void>;  // 调用方提供：检查 daemon 是否运行，没运行就启动
}

export interface ViewportInfra {
  audit: AuditLog; // audit sink for createWatcher
  fsFactory: (baseDir: string) => FileSystem;
}

export type ChatViewportOptions = ViewportIdentity & ViewportDisplayOptions & ViewportLifecycle & ViewportInfra;

export type { TurnTracker } from './chat-viewport-types.js';

// phase 426 Step C (review medium): slash-command quote-aware tokenizer
// 支持 "..." / '...'、连续空格折叠、未闭引号宽松（剩余当 token、不抛）。
// 不支持 escape \" (首版最简、按需扩)。
function tokenizeSlashArgs(s: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) { quote = null; continue; }
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c as '"' | "'";
    } else if (/\s/.test(c)) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export async function runChatViewport(options: ChatViewportOptions): Promise<void> {
  const pm = createProcessManagerForCLI({ fsFactory: options.fsFactory });
  // 确保 daemon 运行
  if (options.ensureDaemon) {
    await options.ensureDaemon();
  }

  const { fs } = createDirContext({ fsFactory: options.fsFactory }, options.agentDir);
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
        const cols = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
        spawnText.setText(taskStatusBar.renderSpawn(cols));
        shadowText.setText(taskStatusBar.renderShadow(cols));
        tui.requestRender();
      });
    },
  });

  // 输入组件
  const editor = new Editor(tui, editorTheme);

  // Motion viewport：各 claw 步数追踪
  const isMotion = options.label === MOTION_CLAW_ID;
  const clawsDir = isMotion ? path.join(options.agentDir, '..', CLAWS_DIR) : '';
  const clawsFs = isMotion && clawsDir ? createDirContext({ fsFactory: options.fsFactory }, clawsDir).fs : fs;
  // phase 462 (review N3-M): chestnutRoot 应为 .chestnut 子目录、与 motion 路径同
  // motion: agentDir=.chestnut/motion → ..        =.chestnut
  // claw:   agentDir=.chestnut/claws/<n> → ../.. =.chestnut
  // 改前非 motion 漏一层 → chestnutRoot = clawDir 自身 → clawTopology 误路由
  const chestnutRoot = isMotion ? path.join(options.agentDir, '..') : path.join(options.agentDir, '..', '..');
  const clawTopology = createClawTopology({ fs: clawsFs, chestnutRoot, audit: options.audit, motionDir: isMotion ? options.agentDir : String(MOTION_CLAW_ID) });
  const clawTrackMap = new Map<string, ClawTrack>();

  const clawPanel = createClawPanel({ attachedClawBar });

  // Display 使用 mutable holder pattern 让后续赋值的 mainUI 可被 display 读取
  const mainUIHolder: { ref?: MainTurnUIController } = {};
  const displayWithHolder = createDisplay({
    label: options.label,
    outputText,
    tui,
    observability,
    get mainUI() { return mainUIHolder.ref; },
    updateClawPanel: clawPanel.updateClawPanel,
    clawTrackMap,
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

  const stopTaskWatch = async (taskId: TaskId) => {
    const tw = taskWatchMap.get(taskId);
    if (!tw) return;
    await tw.streamReader?.stop();
    taskWatchMap.delete(taskId);
    // phase 1401 Bug C: stale-sweep / shutdown 路径必须与 turn_end happy path 对称清 UI track。
    // turn_end 走 chat-viewport-task-events.ts:44-45 updateTrack(turn_end) → 内部 removeTrack；
    // 但 stopTaskWatch 之前不清 UI track → shadowTracks/spawnTracks 残留 `⊙ ()` 渲染永不清。
    // removeTrack 是 idempotent（taskStatusBar:93-98 findIndex 找不到 silent return）。
    taskStatusBar.removeTrack(taskId);
  };

  const _taskEventHandler = createTaskEventHandler({
    stopTaskWatch,
    taskStatusBar,
    audit: options.audit,
  });
  // phase 367 step A: per-task lazy stale check 替原 60s setInterval sweep
  // 每个 task event 到达时检 tw.lastEventMs 是否过 TASK_STALE_TIMEOUT_MS、过则 cleanup
  // 替代:
  //   - taskSweepInterval (60s 全扫) → 内联 lazy check
  const TASK_STALE_TIMEOUT_MS = 30 * 60 * 1000;
  const handleTaskEvent = (taskId: TaskId, ev: unknown): void => {
    const tw = taskWatchMap.get(taskId);
    if (tw) {
      const now = Date.now();
      const idleMs = now - tw.lastEventMs;
      if (idleMs > TASK_STALE_TIMEOUT_MS) {
        // task 已 stale: cleanup 而非 process event (phase 1401 Bug B: 5min 太短 → 30min)
        stopTaskWatch(makeTaskId(taskId)).catch(err =>
          // phase 702: 拆 taskId + reason 为两 col、与 phase 690-695 同模式
          options.audit.write(
            VIEWPORT_AUDIT_EVENTS.TASK_WATCH_STOP_FAILED,
            `taskId=${taskId}`,
            `reason=${formatErr(err)}`,
          )
        );
        try {
          options.audit.write(
            VIEWPORT_AUDIT_EVENTS.TASK_STREAM_STALE_CLEANUP,
            `taskId=${taskId}`,
            `idle_ms=${idleMs}`,
          );
        } catch { /* silent: audit self-failure tolerated */ }
        return;
      }
    }
    _taskEventHandler(taskId, ev as Parameters<typeof _taskEventHandler>[1]);
  };

  const handleEvent = createEventHandler({
    turnTracker,
    mainUI,
    sink: displayWithHolder.descriptorSink,
    resolvePending: displayWithHolder.resolvePending,
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
    fsFactory: options.fsFactory,
  });

  // tail stream.jsonl
  const streamReader = createStreamReader(fs, STREAM_FILE, (ev) => mainUI.withScope('main', () => handleEvent(ev)), options.audit, { persistent: false });
  const recentTurnOffset = findRecentTurnStartOffset(fs, STREAM_FILE);
  try {
    streamReader.start(recentTurnOffset);
  } catch (err) {
    // declared field 装配端兑现 per phase 1325 / existing VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED
    options.audit.write(
      VIEWPORT_AUDIT_EVENTS.STREAM_READER_START_FAILED,
      `reason=${formatErr(err)}`,
      `offset=${recentTurnOffset}`,
    );
    mainUI.withScope('main', () => {
      // fallback render — let user know stream tail unavailable but viewport survives
      // `} as any`: synthetic system_message event 不在 ChatViewportEvent union (fallback-only literal / phase 1382 audit-trail B-3 ratify)
      handleEvent({ type: 'system_message', text: 'Stream reader 启动失败，部分实时更新功能受限。Audit log 已记录。' } as any);
    });
  }

  const clawManager = createClawManager({
    fs: clawsFs, pm, audit: options.audit, isMotion, clawTopology, clawTrackMap,
    updateClawPanel: clawPanel.updateClawPanel,
    requestRender: () => tui.requestRender(),
  });

  // 事件驱动：claws/ dir add/unlink 触发 refresh + rescan + panel re-render（替原 3 setInterval polling、phase 361）
  // 替代:
  //   - clawRefreshInterval (2s) → refreshAllClawStatus
  //   - clawPanelTickInterval (1s) → updateClawPanel + requestRender
  //   - clawScanInterval → rescanClawsDir
  let clawsWatcher: Watcher | null = null;
  const scheduleClawPanelUpdate = (): void => {
    if (clawTrackMap.size > 0) {
      clawPanel.updateClawPanel(clawTrackMap);
      tui.requestRender();
    }
  };
  let rescanClawsDirFn: (() => void) | null = null;
  if (isMotion && clawsDir) {
    rescanClawsDirFn = createRescanClawsDir({
      clawsFs, clawTopology, clawTrackMap, clawManager,
      audit: options.audit, agentDir: options.agentDir, updateClawPanel: clawPanel.updateClawPanel,
    });
    // initial 同步
    clawManager.refreshAllClawStatus();
    rescanClawsDirFn();
    clawsWatcher = createWatcher(
      clawsDir,
      (event) => {
        if (event.type === 'add' || event.type === 'unlink' || event.type === 'addDir' || event.type === 'unlinkDir') {
          clawManager.refreshAllClawStatus();
          rescanClawsDirFn?.();
          scheduleClawPanelUpdate();
        }
      },
      { persistent: false, stability: 'stable' },
    );
  }

  // Daemon 存活检测（事件驱动：PID file unlink 触发、phase 361 替原 setInterval polling）
  // daemon SIGKILL 不清 PID 的情形由 watchdog stale PID 清理覆盖（会触 'unlink'）.
  let daemonDead = false;
  const onDaemonDead = (): void => {
    if (daemonDead) return;
    daemonDead = true;
    // 进程不存在
    turnTracker.abort();
    displayWithHolder.appendOutput('\x1b[31m', '✗ Daemon stopped');
    observability.recordShutdown('daemon_dead');
  };
  const daemonLivenessWatcher = createDaemonLivenessMonitor({
    pidFilePath: pm.getPidFilePath(resolveClawDaemonDir(makeClawId(options.label))),
    onDead: onDaemonDead,
    onError: (err) => process.stderr.write(`[viewport] daemon liveness watcher error: ${err.message}\n`),
  });

  // Stale task stream cleanup: phase 367 改 per-task lazy check (handleTaskEvent 内 inline 上方)
  // phase 1401 Bug B: 30min stale timeout 业务 threshold 不动；sweep 周期 setInterval 删（事件驱动 lazy 替）

  // --- 注册 slash 命令 ---
  for (const cmd of createViewportCommands({
    isMotion, clawTopology, clawTrackMap, fs,
    mainUI, clawManager,
    getThinkingMode: () => thinkingMode,
    setThinkingMode: (m) => { thinkingMode = m; },
    getRegistry: () => commandRegistry,
  })) {
    registerCmd(cmd);
  }

  // 输入提交处理
  editor.onSubmit = async (text: string) => {
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
      const args = rawTail ? tokenizeSlashArgs(rawTail) : [];
      const cmd = commandRegistry.get(name);
      if (cmd) {
        try {
          const result = await cmd.execute(args);
          for (const d of result.descriptors) {
            displayWithHolder.descriptorSink.emit(d);
          }
        } catch (err) {
          const msg = formatErr(err);
          try {
            options.audit.write(VIEWPORT_AUDIT_EVENTS.COMMAND_ERROR, `name=${name}`, `reason=${msg}`);
          } catch { /* audit self-failure tolerated */ }
          displayWithHolder.appendOutput('\x1b[31m', `[error] /${name} failed: ${msg}`, true);
        }
      } else {
        displayWithHolder.appendOutput('\x1b[31m', `[unknown command: /${name}]  type /help for available commands`);
      }
      editor.setText('');
      tui.requestRender();
      return;
    }

    // 显示用户消息
    displayWithHolder.appendOutput('\x1b[32m', `> ${trimmed} (pending)`, true);
    editor.setText('');
    editor.addToHistory(trimmed);

    // 写入 inbox
    try {
      writeUserChat(
        options.agentDir,
        trimmed,
        options.fsFactory,
        options.userInputInlineMaxChars,  // undefined 时 writeUserChat 走默认 EXEC_MAX_OUTPUT
      );
    } catch (err) {
      const msg = formatErr(err);
      displayWithHolder.appendOutput('\x1b[31m', `[error] failed to send message: ${msg} (retry or check disk / permissions)`, true);
    }
    tui.requestRender();
  };

  // Ctrl+C / Ctrl+D 退出
  let resolveExit: () => void;
  const exitPromise = new Promise<void>(r => { resolveExit = r; });
  let shutdownReason: ShutdownReason = 'user_quit';

  tui.addInputListener(createTuiInputHandler({
    fs, agentDir: options.agentDir, turnTracker, mainUI, editor,
    requestRender: () => tui.requestRender(),
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
  const crashLogPath = path.join(options.agentDir, CHAT_CRASH_LOG_FILE);
  const uncaughtHandler = createUncaughtHandler({ agentDir: options.agentDir, fs, fsFactory: options.fsFactory, tui, crashLogPath, audit: options.audit });
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', uncaughtHandler);

  initOwnStateFromHistory({ isMotion, fs, fsFactory: options.fsFactory, streamPath, turnTracker, audit: options.audit });

  // 重连状态校正：tracker 标 active 但 daemon 实际不存活 / forceReset 防误触 ESC 中断
  if (turnTracker.isActive()) {
    try {
      const stored = await pm.readPid(resolveClawDaemonDir(makeClawId(options.label)));
      if (stored === null) {
        turnTracker.forceReset();
      } else {
        if (!isAlive(stored.pid)) { turnTracker.forceReset(); }
      }
    } catch (e) {
      if (!isFileNotFound(e)) {
        process.stderr.write(`[viewport] turn tracker PID read failed: ${(e as Error).message}\n`);
      }
      turnTracker.forceReset();
    }
  }

  tui.start();

  // 终端窗口焦点门控：未聚焦时清除 editor 反色光标，避免多 pane 同时常驻
  // DECSET 1004：进入焦点收 ESC[I、离开收 ESC[O（tmux 需 `set -g focus-events on`）
  process.stdout.write('\x1b[?1004h');
  const focusListener = (data: string) => {
    if (!data.includes('\x1b[I') && !data.includes('\x1b[O')) return {};
    let rest = data;
    let lastEvent: 'in' | 'out' | null = null;
    while (true) {
      const i = rest.indexOf('\x1b[I');
      const o = rest.indexOf('\x1b[O');
      if (i < 0 && o < 0) break;
      if (i >= 0 && (o < 0 || i < o)) {
        lastEvent = 'in';
        rest = rest.slice(0, i) + rest.slice(i + 3);
      } else {
        lastEvent = 'out';
        rest = rest.slice(0, o) + rest.slice(o + 3);
      }
    }
    if (lastEvent === 'in') tui.setFocus(editor);
    else if (lastEvent === 'out') tui.setFocus(null);
    tui.requestRender();
    return rest.length === 0 ? { consume: true } : { data: rest };
  };
  tui.addInputListener(focusListener);

  // clawsDir rescan + refreshAllClawStatus 已合并到 clawsWatcher 事件驱动路径上方（phase 361）

  // 兜底：SIGINT 退出（终端未进 raw mode 时 Ctrl+C 转为 SIGINT）
  const sigintHandler = () => resolveExit();
  process.on('SIGINT', sigintHandler);
  // SIGTERM 退出（chestnut stop 发送 / 让 stop 命令能 kill viewport process）
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
    // silent: cleanup path; watcher close 失败不影响 viewport 退出 / shutdown observability 已 record
    if (clawsWatcher) await clawsWatcher.close().catch(() => { /* silent: cleanup */ });
    await daemonLivenessWatcher.close().catch(() => { /* silent: cleanup */ });
    // phase 367: taskSweepInterval 删、改 per-task lazy check (handleTaskEvent inline)
    await streamReader.stop();
    await clawManager.closeAll();
    // clawScanInterval 已删 → clawsWatcher 替（cleanup 在上方 await clawsWatcher.close()）
    await Promise.all(
      Array.from(taskWatchMap.values())
        .map(tw => tw.streamReader?.stop())
        .filter((p): p is Promise<void> => p !== undefined)
    );
    taskWatchMap.clear();
    process.stdout.write('\x1b[?1004l');
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
