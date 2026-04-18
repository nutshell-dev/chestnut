/**
 * Chat Viewport - tail stream.jsonl 并渲染 TUI
 * motion 和 claw 共用
 */

import * as fsNative from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';

import { writeInboxMessage } from '../../utils/inbox-writer.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { AuditWriter } from '../../foundation/audit/index.js';
import { getContractCreatedMs, LLM_OUTPUT_EVENTS } from './watchdog-utils.js';
import stringWidth from 'string-width';
import { sliceFromStart, fitLine, wrapLine } from '../utils/string.js';
import { OUTPUT_LINES_CAP } from '../../constants.js';
import type { CallerType } from '../../core/tools/caller-type.js';

export interface ChatViewportOptions {
  agentDir: string;   // motion dir 或 claw dir
  label: string;      // 显示名，如 'motion' 或 'claw-search'
  ensureDaemon?: () => Promise<void>;  // 调用方提供：检查 daemon 是否运行，没运行就启动
  showRecapStream?: boolean;   // 复盘子代理 stream，默认 false
  showSystemMessages?: boolean;   // system message，默认 false
  showContractEvents?: boolean;   // contract 子任务完成信息，默认 true
  trimOutputNewlines?: boolean;   // LLM 输出首尾换行清理，默认 true
}

function writeUserChat(agentDir: string, message: string): void {
  const inboxDir = path.join(agentDir, 'inbox', 'pending');
  const fs = new NodeFileSystem({ baseDir: agentDir, enforcePermissions: false });
  const audit = new AuditWriter(fs, path.join(agentDir, 'audit.tsv'));
  writeInboxMessage(fs, {
    inboxDir,
    type: 'user_chat',
    source: 'user',
    priority: 'high',
    body: message,
    idPrefix: 'chat',
    audit,
  });
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}


export async function runChatViewport(options: ChatViewportOptions): Promise<void> {
  // 确保 daemon 运行
  if (options.ensureDaemon) {
    await options.ensureDaemon();
  }

  const showRecapStream = options.showRecapStream ?? false;
  const showSystemMessages = options.showSystemMessages ?? false;
  const showContractEvents = options.showContractEvents ?? true;
  const trimOutputNewlines = options.trimOutputNewlines ?? true;

  const { TUI, Text, Editor, EditorKeybindingsManager, setEditorKeybindings, ProcessTerminal } = await import('@mariozechner/pi-tui');

  // 移除 Ctrl+C 从 Editor 的 selectCancel，让 TUI listener 处理
  setEditorKeybindings(new EditorKeybindingsManager({
    selectCancel: 'escape',  // 只绑 ESC
  }));

  const streamPath = path.join(options.agentDir, 'stream.jsonl');
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
  let streamingSuffix = '';  // 当前流式内容（spinner / thinking / text）

  let streamingBuffer = '';
  let thinkingBuffer = '';
  let inTurn = false;  // daemon 是否正在处理 turn（用于 ESC 中断判断）
  let escTimeoutId: ReturnType<typeof setTimeout> | null = null;  // ESC 5秒超时定时器

  // 状态栏追踪

  type ThinkingMode = 'compact' | 'full' | 'off';
  let thinkingMode: ThinkingMode = 'full';

  // --- 命令注册表 ---
  interface ViewportCommand {
    name: string;
    description: string;
    usage?: string;
    execute: (args: string[]) => void;
  }
  const commandRegistry = new Map<string, ViewportCommand>();
  const registerCmd = (cmd: ViewportCommand) => commandRegistry.set(cmd.name, cmd);

  // Braille spinner 动画
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  const updateDisplay = () => {
    const cols = process.stdout.columns ?? 80;
    const body = outputLines
      .flatMap(({ color, text, wrap, hangIndent }) => {
        const lines = wrap
          ? text.split('\n').flatMap(line => wrapLine(line, cols, hangIndent))
          : [fitLine(text, cols)];
        return lines.map(line => color ? `${color}${line}\x1b[0m` : line);
      })
      .join('\n');

    const suffixBody = streamingSuffix
      ? streamingSuffix.split('\n')
          .flatMap(line => wrapLine(line, cols))
          .join('\n')
      : '';

    const full = suffixBody ? body + '\n' + suffixBody : body;
    outputText.setText(full);
    tui.requestRender();
  };

  const attachedClawBar = new Text('', 0, 0);

  const setStreamingSuffix = (text: string) => {
    streamingSuffix = text;
    updateDisplay();
  };

  const buildClawLine = (id: string, t: ClawTrack, cols: number): string => {
    // Fix 2：daemon 崩溃检测（放在最前，无论 active 状态）
    if (!t.isAlive) {
      return `\x1b[38;5;240m[${id}] ✗ daemon stopped\x1b[0m`;
    }

    if (t.active) {
      const icon = t.toolSuccess === true ? '✓' : t.toolSuccess === false ? '✗' : '⚙';
      if (t.currentTool) {
        if (t.textBuffer) {
          const isThinking = t.bufferType === 'thinking';
          const open = isThinking ? '(' : '"';
          const close = isThinking ? ')' : '"';
          const line = `[${id}] ${icon} ${t.currentTool} · ${open}${t.textBuffer.trimStart().replace(/\n/g, ' ')}${close}`;
          return `\x1b[38;5;147m${fitLine(line, cols)}\x1b[0m`;
        }
        return `\x1b[38;5;147m[${id}] ${icon} ${t.currentTool}\x1b[0m`;
      }
      const inner = t.textBuffer
        ? t.textBuffer.trimStart().replace(/\n/g, ' ')
        : '';
      return `\x1b[38;5;147m${fitLine(`[${id}] ⊙ (${inner})`, cols)}\x1b[0m`;
    }

    // 不活跃
    let leftText: string;
    let leftColor: string;
    if (!t.hasContract) {
      leftText = `[${id}] ○ no contract`;
      leftColor = '\x1b[38;5;245m';
    } else if (t.lastError) {
      const dur = t.referenceMs ? ` · inactive ${fmtDuration(Date.now() - t.referenceMs)}` : '';
      leftText = `[${id}] ✗ ${t.lastError}${dur}`;
      leftColor = '\x1b[38;5;214m';
    } else if (t.lastInterrupted) {
      const dur = t.referenceMs ? ` · inactive ${fmtDuration(Date.now() - t.referenceMs)}` : '';
      leftText = `[${id}] ✗ interrupted${dur}`;
      leftColor = '\x1b[38;5;214m';
    } else {
      const dur = t.referenceMs ? `inactive ${fmtDuration(Date.now() - t.referenceMs)}` : '';
      leftText = dur ? `[${id}] ○ ${dur}` : `[${id}] ○`;
      leftColor = '\x1b[38;5;245m';
    }

    // 净化并截断 leftText，确保 attach bar 单行显示
    leftText = fitLine(leftText, cols);

    if (t.lastOutput) {
      const prefix = `${leftText} · "`;
      const available = cols - stringWidth(prefix) - 1;
      const snippet = sliceFromStart(t.lastOutput.trimStart().replace(/\n/g, ' '), available);
      return `${leftColor}${prefix}${snippet}"\x1b[0m`;
    }
    return `${leftColor}${leftText}\x1b[0m`;
  };

  const updateClawPanel = () => {
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

  const startSpinner = (text = 'Thinking...') => {
    stopSpinner();
    let frame = 0;
    spinnerTimer = setInterval(() => {
      streamingSuffix = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text}`;
      updateDisplay();
      frame++;
    }, 80);
    // 立即显示第一帧
    setStreamingSuffix(`${SPINNER_FRAMES[0]} ${text}`);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  // 输入组件
  const editor = new Editor(tui, editorTheme);

  const appendOutput = (color: string, text: string, wrap = false, hangIndent = '') => {
    outputLines.push({ color, text, wrap, hangIndent });
    if (outputLines.length > OUTPUT_LINES_CAP) {
      outputLines.splice(0, outputLines.length - OUTPUT_LINES_CAP);
    }
    updateDisplay();
  };

  const flushStreaming = () => {
    if (streamingBuffer) {
      const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
      const indent = '  ';
      const content = trimOutputNewlines ? streamingBuffer.trim() : streamingBuffer;
      const formatted = content
        .split('\n')
        .map((line, i) => (i === 0 ? dotPrefix : indent) + line)
        .join('\n');
      streamingBuffer = '';
      streamingSuffix = '';
      appendOutput('', formatted, true, indent);
    }
  };

  const flushThinking = () => {
    if (thinkingBuffer) {
      const prefix = '⏺ ';
      const indent = ' '.repeat(stringWidth(prefix));
      const content = trimOutputNewlines ? thinkingBuffer.trim() : thinkingBuffer;
      const formatted = content
        .split('\n')
        .map((line, i) => (i === 0 ? prefix : indent) + line)
        .join('\n');
      appendOutput('\x1b[2m', formatted, true, indent);
      thinkingBuffer = '';
    }
  };

  // 处理一个 stream event
  const handleEvent = (event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case 'turn_start': {
        inTurn = true;
        flushThinking();
        flushStreaming();
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
        inTurn = true;
        flushThinking();
        flushStreaming();
        startSpinner();
        break;

      case 'thinking_delta':
        stopSpinner();
        thinkingBuffer += event.delta as string;
        if (thinkingMode === 'full') {
          const prefix = '⏺ ';
          const indent = ' '.repeat(stringWidth(prefix));
          const preview = thinkingBuffer
            .split('\n')
            .map((line, i) => (i === 0 ? prefix : indent) + line)
            .join('\n');
          setStreamingSuffix('\x1b[2m' + preview + '\x1b[0m');
        } else if (thinkingMode === 'compact') {
          const snippet = thinkingBuffer.replace(/\s+/g, ' ').trim().slice(-60);
          setStreamingSuffix('\x1b[2m(' + snippet + ')\x1b[0m');
        }
        // 'off': 不更新 suffix
        break;

      case 'text_delta':
        stopSpinner();
        flushThinking();
        streamingBuffer += event.delta as string;
        {
          const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
          const indent = '  ';
          const preview = (streamingBuffer + '▋')
            .split('\n')
            .map((line, i) => (i === 0 ? dotPrefix : indent) + line)
            .join('\n');
          setStreamingSuffix(preview);
        }
        break;

      case 'text_end':
        // no-op: keep cursor (▋) visible until tool_call/turn_end flushes
        break;

      case 'tool_call':
        stopSpinner();
        flushThinking();
        flushStreaming();
        appendOutput('\x1b[36m', `⚙ ${event.name}`);
        startSpinner(`${event.name}...`);
        break;

      case 'tool_result': {
        stopSpinner();
        const icon = event.success ? '✓' : '✗';
        const step = event.step ?? '?';
        const maxSteps = event.maxSteps ?? '?';
        streamingSuffix = '';
        appendOutput('\x1b[2m', `  ${icon} [${step}/${maxSteps}] ${event.summary as string}`);
        break;
      }

      case 'turn_end':
        inTurn = false;
        stopSpinner();
        flushThinking();
        flushStreaming();
        streamingSuffix = '';
        updateDisplay();
        pendingInterruptSource = null;
        // Cursor disappearance signals completion; no extra separator needed
        break;

      case 'turn_interrupted': {
        inTurn = false;
        stopSpinner();
        flushThinking();
        flushStreaming();
        streamingSuffix = '';
        updateDisplay();
        const msg = (event as Record<string, unknown>).message;
        const display = typeof msg === 'string' ? msg
          : pendingInterruptSource === 'esc' ? 'Interrupted (Esc)' : 'Interrupted';
        pendingInterruptSource = null;
        appendOutput('\x1b[33m', display);
        break;
      }

      case 'turn_error':
        inTurn = false;
        stopSpinner();
        flushThinking();
        flushStreaming();
        streamingSuffix = '';
        updateDisplay();
        pendingInterruptSource = null;
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
        stopSpinner();   // 防止 spinner 在通知输出时继续转
        streamingSuffix = '';   // 清除游标/spinner 残留
        updateDisplay();
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
        const streamPath = path.join(options.agentDir, 'tasks', 'results', taskId, 'stream.jsonl');
        const tw: TaskWatch = {
          callerType: callerType as any,
          silent: (event.silent as boolean) ?? false,
          fileSize: 0, leftover: '', watcher: null,
        };
        taskWatchMap.set(taskId, tw);
        try {
          tw.watcher = fsNative.watch(streamPath, { persistent: false }, () => pollTaskStream(taskId));
          tw.watcher.on('error', () => {
            tw.watcher?.close();
            tw.watcher = null;
          });
        } catch { /* fallback to poll */ }
        break;
      }
    }
  };

  // tail stream.jsonl
  let fileSize = 0;
  let leftover = '';

  // Motion viewport：各 claw 步数追踪
  const isMotion = options.label === 'motion';
  const clawsDir = isMotion ? path.join(options.agentDir, '..', 'claws') : '';
  interface ClawTrack {
    // 轻量字段
    fileSize: number;
    leftover: string;
    turnCount: number;
    step: number;
    maxSteps: number;
    active: boolean;
    lastError: string | null;
    hasContract: boolean;
    isAlive: boolean;

    // 新增（rich，详细行用）
    currentTool: string | null;
    toolSuccess: boolean | null;
    textBuffer: string;
    bufferType: 'thinking' | 'text' | null;
    lastOutput: string;
    lastInterrupted: boolean;
    referenceMs: number | null;
    clearOnNextDelta: boolean;
  }

  function makeClawTrack(): ClawTrack {
    return {
      fileSize: 0, leftover: '', turnCount: 0, step: 0, maxSteps: 100,
      active: false, lastError: null, hasContract: false, isAlive: false,
      currentTool: null, toolSuccess: null, textBuffer: '', bufferType: null,
      lastOutput: '', lastInterrupted: false, referenceMs: null, clearOnNextDelta: false,
    };
  }
  const clawTrackMap = new Map<string, ClawTrack>();
  const clawWatchers = new Map<string, ReturnType<typeof fsNative.watch>>();
  let lastClawRefreshTs = 0;

  // Task stream watching (for dispatch/spawn subagent progress)
  interface TaskWatch {
    callerType: CallerType;
    silent: boolean;
    fileSize: number;
    leftover: string;
    watcher: ReturnType<typeof fsNative.watch> | null;
  }
  const taskWatchMap = new Map<string, TaskWatch>();

  // Interrupt source tracking (for turn_interrupted display)
  let pendingInterruptSource: 'esc' | null = null;

  const stopTaskWatch = (taskId: string) => {
    const tw = taskWatchMap.get(taskId);
    if (!tw) return;
    tw.watcher?.close();
    taskWatchMap.delete(taskId);
  };

  try {
    const stat = fsNative.statSync(streamPath);
    fileSize = stat.size;  // 从当前末尾开始（不 replay 历史）
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[chat] Failed to stat stream file: ${err?.message}`);
    }
    // ENOENT: 文件不存在，从 0 开始
  }

  let lastEnoentWarnTs = 0;

  const pollStream = () => {
    try {
      const stat = fsNative.statSync(streamPath);
      if (stat.size < fileSize) {  // daemon 重启截断了文件，重置读取位置到头部
        fileSize = 0;
        leftover = '';
      }
      if (stat.size <= fileSize) return;

      const toRead = stat.size - fileSize;
      const buf = Buffer.alloc(toRead);
      const fd = fsNative.openSync(streamPath, 'r');
      let bytesRead = 0;
      try {
        while (bytesRead < toRead) {
          const n = fsNative.readSync(fd, buf, bytesRead, toRead - bytesRead, fileSize + bytesRead);
          if (n === 0) break;  // EOF（文件被截断）
          bytesRead += n;
        }
      } finally {
        fsNative.closeSync(fd);
      }
      fileSize += bytesRead;

      const chunk = leftover + buf.toString('utf-8');
      const lines = chunk.split('\n');
      leftover = lines.pop() ?? '';  // 最后一段可能不完整，留待下次
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleEvent(event);
        } catch {
          if (line.trim().length > 2) {
            console.warn(`[chat] Failed to parse stream event: ${line.slice(0, 80)}`);
          }
        }
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        if (Date.now() - lastEnoentWarnTs >= 60000) {
          console.warn('[chat] pollStream ENOENT (daemon may not be running):', err.message);
          lastEnoentWarnTs = Date.now();
        }
        return;
      }
      // 文件可能被截断（daemon 重启），重置
      console.warn('[chat] pollStream error, resetting position:', err instanceof Error ? err.message : String(err));
      fileSize = 0;
      leftover = '';
    }
  };

  const refreshClawStatus = (clawId: string) => {
    if (!isMotion) return;
    const track = clawTrackMap.get(clawId);
    if (!track) return;

    const streamFile = path.join(clawsDir, clawId, 'stream.jsonl');

    try {
      const stat = fsNative.statSync(streamFile);
      if (stat.size < track.fileSize) {
        // 旧 watcher 追踪归档 inode，需要替换（Bug 2 修复）
        const stale = clawWatchers.get(clawId);
        if (stale) { stale.close(); clawWatchers.delete(clawId); }
        try {
          const w = fsNative.watch(streamFile, { persistent: false }, () => refreshClawStatus(clawId));
          w.on('error', () => { w.close(); clawWatchers.delete(clawId); });
          clawWatchers.set(clawId, w);
        } catch { /* polling fallback */ }
        // reset state
        track.fileSize = 0; track.leftover = '';
        track.turnCount = 0; track.step = 0; track.active = false; track.lastError = null;
        track.currentTool = null; track.toolSuccess = null; track.textBuffer = '';
        track.bufferType = null; track.lastOutput = ''; track.lastInterrupted = false;
        track.clearOnNextDelta = false;
      }
      if (stat.size > track.fileSize) {
        const toRead = stat.size - track.fileSize;
        const buf = Buffer.alloc(toRead);
        const fd = fsNative.openSync(streamFile, 'r');
        let bytesRead = 0;
        try {
          while (bytesRead < toRead) {
            const n = fsNative.readSync(fd, buf, bytesRead, toRead - bytesRead, track.fileSize + bytesRead);
            if (n === 0) break;
            bytesRead += n;
          }
        } finally { fsNative.closeSync(fd); }
        track.fileSize += bytesRead;

        const chunk = track.leftover + buf.toString('utf-8');
        const lines = chunk.split('\n');
        track.leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            // 轻量字段
            if (ev.type === 'turn_start') { track.turnCount++; track.step = 0; track.active = true; }
            else if (ev.type === 'tool_result') { track.step = ev.step ?? track.step; track.maxSteps = ev.maxSteps ?? track.maxSteps; }
            else if (ev.type === 'turn_error') { track.active = false; track.lastError = (ev.error as string) ?? 'error'; }
            else if (ev.type === 'turn_end' || ev.type === 'turn_interrupted') { track.active = false; track.lastError = null; }

            // rich 字段（详细行用）- 对每条 track 都执行
            //
            // textBuffer 积累"最后一段连续文本"，供 turn_end 时写入 lastOutput（clawbar 摘要）。
            // clearOnNextDelta 由 tool_call 触发置 true，下一个 delta 到来时清空 buffer，
            // 确保 lastOutput 只反映最后一段 LLM 输出，而非跨工具调用的拼接。
            if (LLM_OUTPUT_EVENTS.has(ev.type)) {
              if (track.active === false) track.lastOutput = '';
              track.active = true;
              if (ev.type === 'thinking_delta') {
                if (track.clearOnNextDelta) {
                  track.textBuffer = '';
                  track.bufferType = null;
                  track.clearOnNextDelta = false;
                }
                track.textBuffer += (ev.delta as string) ?? '';
                track.bufferType = 'thinking';
              } else if (ev.type === 'tool_call') {
                track.currentTool = (ev.name as string) ?? null;
                track.toolSuccess = null;
                track.clearOnNextDelta = true;
              } else if (ev.type === 'text_delta') {
                if (track.bufferType !== 'text' || track.clearOnNextDelta) {
                  track.textBuffer = '';
                  track.bufferType = 'text';
                  track.clearOnNextDelta = false;
                }
                track.textBuffer += (ev.delta as string) ?? '';
              }
            } else if (ev.type === 'tool_result') {
              track.toolSuccess = (ev.success as boolean) ?? null;
            } else if (ev.type === 'turn_start') {
              track.lastOutput = '';
              track.lastInterrupted = false;
            } else if (ev.type === 'turn_end') {
              track.active = false; track.lastInterrupted = false;
              if (track.textBuffer) track.lastOutput = track.textBuffer;
              track.currentTool = null; track.textBuffer = '';
              track.toolSuccess = null; track.bufferType = null; track.clearOnNextDelta = false;
              track.referenceMs = Date.now();
            } else if (ev.type === 'turn_error') {
              track.active = false; track.lastInterrupted = false;
              track.currentTool = null; track.textBuffer = '';
              track.toolSuccess = null; track.bufferType = null; track.lastOutput = ''; track.clearOnNextDelta = false;
              track.lastError = (ev.error as string) ?? 'error';
              track.referenceMs = Date.now();
            } else if (ev.type === 'turn_interrupted') {
              track.active = false; track.lastInterrupted = true;
              track.currentTool = null; track.textBuffer = '';
              track.toolSuccess = null; track.bufferType = null; track.lastOutput = ''; track.clearOnNextDelta = false;
              track.referenceMs = Date.now();
            }

            updateClawPanel();
            tui.requestRender();
          } catch { /* skip */ }
        }
      }
    } catch { /* ENOENT 等，跳过 */ }
  };

  const refreshAllClawStatus = () => {
    if (!isMotion) return;
    let clawIds: string[] = [];
    try { clawIds = fsNative.readdirSync(clawsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name); } catch { return; }

    // 清理已删除的 claw
    for (const [id] of clawTrackMap) {
      if (!clawIds.includes(id)) {
        clawWatchers.get(id)?.close();
        clawWatchers.delete(id);
        clawTrackMap.delete(id);
      }
    }

    for (const clawId of clawIds) {
      const streamFile = path.join(clawsDir, clawId, 'stream.jsonl');
      if (!clawTrackMap.has(clawId)) {
        const clawDir = path.join(clawsDir, clawId);
        const contractMs = getContractCreatedMs(clawDir);
        if (contractMs === null) continue;
        const track = makeClawTrack();
        track.hasContract = true;
        track.referenceMs = contractMs;
        clawTrackMap.set(clawId, track);
      }
      if (!clawWatchers.has(clawId)) {
        try {
          const w = fsNative.watch(streamFile, { persistent: false }, () => refreshClawStatus(clawId));
          w.on('error', () => {
            w.close();
            clawWatchers.delete(clawId);
          });
          clawWatchers.set(clawId, w);
        } catch { /* fallback to polling */ }
      }
      const track = clawTrackMap.get(clawId)!;

      // Contract check (hasContract 已在初始化时设置，此处可省略或保留作为刷新)
      // referenceMs 初始化后不再修改，除非契约重新创建

      // Process alive check
      const clawPidFile = path.join(clawsDir, clawId, 'status', 'pid');
      try {
        const pid = parseInt(fsNative.readFileSync(clawPidFile, 'utf-8').trim(), 10);
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, 0);
            track.isAlive = true;
          } catch (e) {
            track.isAlive = (e as NodeJS.ErrnoException).code === 'EPERM';
          }
        } else { track.isAlive = false; }
      } catch { track.isAlive = false; }
      // Fix 2：刷新 hasContract（契约可能完成或新创建）
      track.hasContract = getContractCreatedMs(path.join(clawsDir, clawId)) !== null;
      // 兜底：轮询时顺带读一次流（watcher 失效时的保障，Bug 3 修复）
      refreshClawStatus(clawId);
    }
  };

  // Poll task stream for subagent progress (dispatch/spawn)
  const pollTaskStream = (taskId: string) => {
    const tw = taskWatchMap.get(taskId);
    if (!tw) return;
    const streamPath = path.join(options.agentDir, 'tasks', 'results', taskId, 'stream.jsonl');
    try {
      const stat = fsNative.statSync(streamPath);
      if (stat.size <= tw.fileSize) return;
      const toRead = stat.size - tw.fileSize;
      const buf = Buffer.alloc(toRead);
      const fd = fsNative.openSync(streamPath, 'r');
      let bytesRead = 0;
      try {
        while (bytesRead < toRead) {
          const n = fsNative.readSync(fd, buf, bytesRead, toRead - bytesRead, tw.fileSize + bytesRead);
          if (n === 0) break;
          bytesRead += n;
        }
      } finally { fsNative.closeSync(fd); }
      tw.fileSize += bytesRead;

      const chunk = tw.leftover + buf.toString('utf-8');
      const lines = chunk.split('\n');
      tw.leftover = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          handleTaskEvent(taskId, tw.callerType, ev);
        } catch { }
      }
    } catch { }
  };

  const handleTaskEvent = (
    taskId: string,
    callerType: string,
    event: { type: string; [key: string]: unknown },
  ) => {
    const tw = taskWatchMap.get(taskId);
    const prefix = callerType;
    switch (event.type) {
      case 'tool_call':
        if (tw?.silent && !showRecapStream) break;
        stopSpinner();
        appendOutput('\x1b[36m', `⚙ ${prefix}:${event.name}`);
        startSpinner(`${prefix}:${event.name}...`);
        break;
      case 'tool_result': {
        if (tw?.silent && !showRecapStream) break;
        stopSpinner();
        const icon = event.success ? '✓' : '✗';
        streamingSuffix = '';
        appendOutput('\x1b[2m', `  ${icon} [${event.step}/${event.maxSteps}] ${event.summary as string}`);
        break;
      }
      case 'turn_end':
      case 'turn_error':
      case 'turn_interrupted':
        stopSpinner();
        streamingSuffix = '';
        updateDisplay();
        stopTaskWatch(taskId);
        break;
    }
  };

  // fs.watch + fallback 轮询
  let watcher: ReturnType<typeof fsNative.watch> | null = null;
  const pollInterval = setInterval(() => {
    pollStream();
    if (isMotion) {
      const now = Date.now();
      if (now - lastClawRefreshTs >= 2000) {
        lastClawRefreshTs = now;
        refreshAllClawStatus();
      }
    }
    // Poll task streams for dispatch/spawn progress
    for (const taskId of taskWatchMap.keys()) {
      pollTaskStream(taskId);
    }
    // Attach 不活跃计时：每 5 次 poll (≈1s) 刷新一次
    if (clawTrackMap.size > 0) {
      updateClawPanel();
      tui.requestRender();
    }
  }, 200);  // fallback 200ms

  try {
    watcher = fsNative.watch(streamPath, () => pollStream());
  } catch (err) {
    console.warn('[chat] fs.watch failed, falling back to polling:', err instanceof Error ? err.message : String(err));
  }

  // Daemon 存活检测（每 3 秒一次）
  let daemonDead = false;
  const pidFile = path.join(options.agentDir, 'status', 'pid');
  const checkDaemonAlive = () => {
    if (daemonDead) return;
    try {
      const pid = parseInt(fsNative.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!Number.isFinite(pid)) return;
      try {
        process.kill(pid, 0); // 检测存活
      } catch {
        // 进程不存在
        daemonDead = true;
        inTurn = false;
        stopSpinner();
        flushStreaming();
        flushThinking();
        streamingSuffix = '';
        updateDisplay();
        appendOutput('\x1b[31m', '✗ Daemon 已停止');
      }
    } catch {
      // PID 文件不存在或读取失败，忽略
    }
  };
  const daemonCheckInterval = setInterval(checkDaemonAlive, 3000);

  // --- 注册 slash 命令 ---

  registerCmd({
    name: 'think',
    description: '切换思考内容显示模式',
    usage: '/think [off|compact|full]',
    execute: (args) => {
      const arg = args[0] as ThinkingMode | undefined;
      if (!arg) {
        // 无参：在 full 和 off 之间切换
        thinkingMode = thinkingMode === 'off' ? 'full' : 'off';
      } else if (arg === 'off' || arg === 'compact' || arg === 'full') {
        thinkingMode = arg;
      } else {
        appendOutput('\x1b[31m', `[think] 无效模式 "${arg}"，可选：off / compact / full`);
        return;
      }
      appendOutput('\x1b[2m', `[thinking: ${thinkingMode}]`);
    },
  });

  registerCmd({
    name: 'attach',
    description: '将 claw 加入监视面板（仅 motion）',
    usage: '/attach <clawId>',
    execute: (args) => {
      if (!isMotion) {
        appendOutput('\x1b[31m', '[attach] 仅 motion chat 支持 /attach');
        return;
      }
      const clawId = args[0];
      if (!clawId) {
        appendOutput('\x1b[31m', '[attach] 用法：/attach <clawId>');
        return;
      }
      const clawDir = path.join(clawsDir, clawId);
      if (!fsNative.existsSync(clawDir)) {
        appendOutput('\x1b[31m', `[attach] claw "${clawId}" 不存在`);
      } else if (clawTrackMap.has(clawId)) {
        appendOutput('\x1b[2m', `[attach] ${clawId} 已在面板中`);
      } else {
        const t = makeClawTrack();
        t.referenceMs = Date.now();
        clawTrackMap.set(clawId, t);
        try {
          const w = fsNative.watch(path.join(clawDir, 'stream.jsonl'), { persistent: false }, () => refreshClawStatus(clawId));
          w.on('error', () => { w.close(); clawWatchers.delete(clawId); });
          clawWatchers.set(clawId, w);
        } catch { /* polling fallback */ }
        updateClawPanel();
        appendOutput('\x1b[2m', `[attach] ${clawId} 已加入面板`);
      }
    },
  });

  registerCmd({
    name: 'detach',
    description: '从监视面板移除 claw（仅 motion）',
    usage: '/detach <clawId>  或  /detach --all',
    execute: (args) => {
      const arg = args[0];
      if (!arg) {
        appendOutput('', '用法：/detach <claw-id>  或  /detach --all');
        return;
      }
      if (arg === '--all') {
        for (const [id] of clawTrackMap) {
          clawWatchers.get(id)?.close();
          clawWatchers.delete(id);
        }
        clawTrackMap.clear();
        updateClawPanel();
        appendOutput('\x1b[2m', '[detach] 已清空所有 claw');
      } else {
        clawWatchers.get(arg)?.close();
        clawWatchers.delete(arg);
        clawTrackMap.delete(arg);
        updateClawPanel();
        appendOutput('\x1b[2m', `[detach] ${arg} 已从面板移除`);
      }
    },
  });

  registerCmd({
    name: 'clear',
    description: '清空输出区域',
    execute: () => {
      outputLines.length = 0;
      streamingSuffix = '';
      updateDisplay();
    },
  });

  registerCmd({
    name: 'help',
    description: '显示可用命令列表',
    execute: () => {
      const lines = ['可用命令：'];
      for (const cmd of commandRegistry.values()) {
        lines.push(`  ${cmd.usage ?? '/' + cmd.name}  — ${cmd.description}`);
      }
      lines.push('快捷键：ESC 中断当前 turn  /  Ctrl+C 或 Ctrl+D 退出  /  Ctrl+L 清屏');
      appendOutput('\x1b[2m', lines.join('\n'), true);
    },
  });

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
        cmd.execute(args);
      } else {
        appendOutput('\x1b[2m', `[unknown command: /${name}]  输入 /help 查看可用命令`);
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
    writeUserChat(options.agentDir, trimmed);
    tui.requestRender();
  };

  // Ctrl+C / Ctrl+D 退出
  let resolveExit: () => void;
  const exitPromise = new Promise<void>(r => { resolveExit = r; });

  tui.addInputListener((data: string) => {
    // Ctrl+C / Ctrl+D → 退出 viewport（优先检查，避免被 ESC 逻辑抢先）
    // 使用 includes 匹配批量输入（如 \x03\x03\x1b\x1b）
    if (data.includes('\x03') || data.includes('\x04')) {
      resolveExit();
      return { consume: true };
    }
    // Ctrl+L → 清屏
    if (data.includes('\x0c')) {
      outputLines.length = 0;
      streamingSuffix = '';
      updateDisplay();
      return { consume: true };
    }
    // ESC → 中断 daemon react（只在活跃 turn 时有效）
    // 快速连按时 data 可能是多个 \x1b，需检查是否包含 ESC 字节
    // 排除 CSI 序列（\x1b[ 开头的是方向键等）
    if (data.includes('\x1b') && !data.includes('\x1b[') && !data.includes('\r') && !data.includes('\n')) {
      if (!inTurn) {
        // 防御性清理：如果 spinner 还在转，强制停止
        stopSpinner();
        streamingSuffix = '';
        updateDisplay();
        return { consume: true };
      }
      const interruptFile = path.join(options.agentDir, 'interrupt');
      pendingInterruptSource = 'esc';
      try {
        fsNative.writeFileSync(interruptFile, '');
      } catch { /* best-effort */ }
      startSpinner('Interrupting...');
      // 5 秒超时保护：如果 daemon 没响应，强制清理
      if (escTimeoutId) clearTimeout(escTimeoutId);
      escTimeoutId = setTimeout(() => {
        escTimeoutId = null;
        if (inTurn) {
          inTurn = false;
          pendingInterruptSource = null;
          stopSpinner();
          flushStreaming();
          flushThinking();
          streamingSuffix = '';
          updateDisplay();
        }
      }, 5000);
      return { consume: true };
    }
    return undefined;
  });

  // RESIZE 监听：终端尺寸变化时重渲染
  const onResize = () => {
    updateClawPanel();
    updateDisplay();
  };
  process.stdout.on('resize', onResize);

  tui.addChild(outputText);
  tui.addChild(attachedClawBar);  // 默认空字符串 = 零高度
  tui.addChild(editor);
  tui.setFocus(editor);

  // 防御层：任何未捕获异常先还原终端，防止 terminal emulator 因 raw mode 未还原而闪退
  const crashLogPath = path.join(options.agentDir, 'logs', 'chat-crash.log');
  const uncaughtHandler = (err: unknown) => {
    // 写入崩溃日志文件（terminal 关闭后仍可读）
    try {
      const stack = (err instanceof Error) ? err.stack : String(err);
      fsNative.appendFileSync(crashLogPath, `\n[${new Date().toISOString()}] uncaught:\n${stack}\n`);
    } catch { /* ignore */ }
    process.stderr.write(`[chat] uncaught error: ${err}\n`);
    try { tui.stop(); } catch { /* ignore */ }
    // 刷新 stdout 后再退出，防止 escape sequences 被截断触发 Terminal.app crash
    process.stdout.write('', () => { process.exitCode = 1; });
  };
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', uncaughtHandler);

  /** 重连时从历史 stream 初始化自身状态（仅非 motion 调用） */
  const initOwnStateFromHistory = () => {
    if (isMotion) return;
    try {
      const stat = fsNative.statSync(streamPath);
      if (stat.size === 0) return;
      const buf = Buffer.alloc(stat.size);
      const fd = fsNative.openSync(streamPath, 'r');
      try {
        let read = 0;
        while (read < stat.size) {
          const n = fsNative.readSync(fd, buf, read, stat.size - read, read);
          if (n === 0) break;
          read += n;
        }
      } finally { fsNative.closeSync(fd); }
      const lines = buf.toString('utf-8').split('\n');
      lines.pop(); // 末尾不完整行
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'turn_start')       { inTurn = true; }
          else if (ev.type === 'turn_end' || ev.type === 'turn_interrupted' || ev.type === 'turn_error') {
            inTurn = false;
          }
        } catch { /* skip */ }
      }
    } catch { /* ENOENT 等 */ }
  };

  initOwnStateFromHistory();

  // Fix 1：若 inTurn=true 但 daemon 实际不存活，重置以防误触 ESC 中断
  if (inTurn) {
    try {
      const pid = parseInt(fsNative.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!Number.isFinite(pid)) {
        inTurn = false;
      } else {
        try { process.kill(pid, 0); }
        catch { inTurn = false; }
      }
    } catch { inTurn = false; }
  }

  tui.start();

  // Watch clawsDir，新契约出现时自动加入
  let clawsDirWatcher: ReturnType<typeof chokidar.watch> | null = null;
  if (clawsDir) {
    clawsDirWatcher = chokidar.watch(clawsDir, {
      depth: 2,
      ignoreInitial: true,
      persistent: true,
    });
    clawsDirWatcher.on('addDir', () => {
      // 重新扫描，加入尚未在面板中的有契约 claw
      try {
        const entries = fsNative.readdirSync(clawsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const clawId = e.name;
          if (clawTrackMap.has(clawId)) continue;
          const clawDir = path.join(clawsDir, clawId);
          const contractMs = getContractCreatedMs(clawDir);
          if (contractMs !== null) {
            const t = makeClawTrack();
            t.hasContract = true;
            t.referenceMs = contractMs;
            clawTrackMap.set(clawId, t);
            // 开 watcher
            try {
              const w = fsNative.watch(path.join(clawDir, 'stream.jsonl'), { persistent: false }, () => refreshClawStatus(clawId));
              w.on('error', () => { w.close(); clawWatchers.delete(clawId); });
              clawWatchers.set(clawId, w);
            } catch { /* polling fallback */ }
          }
        }
        if (clawTrackMap.size > 0) {
          updateClawPanel();
        }
      } catch { /* ignore */ }
    });
    // 立即触发一次扫描
    refreshAllClawStatus();
  }

  // 兜底：SIGINT 退出（终端未进 raw mode 时 Ctrl+C 转为 SIGINT）
  const sigintHandler = () => resolveExit();
  process.on('SIGINT', sigintHandler);

  await exitPromise;

  // 清理
  if (escTimeoutId) clearTimeout(escTimeoutId);
  process.stdout.off('resize', onResize);
  process.removeListener('SIGINT', sigintHandler);
  process.removeListener('uncaughtException', uncaughtHandler);
  process.removeListener('unhandledRejection', uncaughtHandler);
  stopSpinner();
  clearInterval(pollInterval);
  clearInterval(daemonCheckInterval);
  watcher?.close();
  for (const w of clawWatchers.values()) w.close();
  clawWatchers.clear();
  clawsDirWatcher?.close();
  for (const tw of taskWatchMap.values()) tw.watcher?.close();
  taskWatchMap.clear();
  tui.stop();
  await terminal.drainInput();
  process.stdin.pause();
}
