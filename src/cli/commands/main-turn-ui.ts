/**
 * @module L6.CLI.ChatViewport.MainTurnUI
 * Main turn UI controller — phase-driven status + content preview，min-dwell spinner。
 *
 * 双槽架构（vs 旧版单 suffix 槽）：
 * - status slot：spinner 动画 + label（waiting_llm / running_tool / interrupting）
 * - preview slot：流式内容预览（thinking dim 或 text + cursor）
 * Renderer 组合两槽（status 行在 preview 上方），互不覆盖。
 *
 * Phase 状态机：idle / waiting_llm / streaming_text / running_tool / interrupting
 * 事件 handler 用 enterPhase() 单入口切换，preview 用 setPreview/clearPreview 独立管。
 *
 * Min-dwell：spinner 进 phase 后保证至少 MIN_DWELL_MS 可见。dwell 内的 clear 推迟兑现。
 * 防 StreamReader 同步 while 批读 + tui.requestRender nextTick 批 → spinner 0 帧塌缩。
 */

import stringWidth from 'string-width';
import type { AuditLog } from '../../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { assertNever } from '../../foundation/utils/index.js';

export type TurnUIPhase =
  | 'idle'
  | 'waiting_llm'
  | 'streaming_text'
  | 'running_tool'
  | 'interrupting';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Spinner 帧切换节奏。Exported: e2e 测可镜像验渲染节奏.
 */
export const SPINNER_INTERVAL_MS = 80;

/**
 * Spinner 进 phase 后保证可见 dwell（ms）。dwell 内 clear 推迟兑现。
 * Exported: tests/ 镜像此契约（如 e2e 测 exceed MIN_DWELL_MS 触发 stop sync）.
 */
export const MIN_DWELL_MS = 200;

export interface MainTurnUIDeps {
  appendOutput: (color: string, text: string, wrap?: boolean, hangIndent?: string) => void;
  updateDisplay: () => void;
  trimOutputNewlines: boolean;
  getThinkingMode: () => 'compact' | 'full' | 'off';
  audit: AuditLog;
  observability?: { recordSpinner: (action: 'start' | 'stop', text: string) => void };
}

export interface MainTurnUIController {
  enterPhase(phase: TurnUIPhase, label?: string): void;
  getPhase(): TurnUIPhase;
  setPreview(text: string): void;
  clearPreview(): void;
  getStatus(): string;
  getPreview(): string;
  appendToBuffer(delta: string): string;
  flushStreaming(): void;
  appendToThinking(delta: string): string;
  flushThinking(): void;
  withScope<T>(scope: 'main' | 'task' | 'system', fn: () => T): T;
}

export function createMainTurnUI(deps: MainTurnUIDeps): MainTurnUIController {
  let phase: TurnUIPhase = 'idle';
  let statusLabel = '';
  let statusText = '';
  let preview = '';
  let streamingBuffer = '';
  let thinkingBuffer = '';
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  let spinnerStartTs = 0;
  let spinnerStopTs = 0;   // phase 881: last stopSpinnerNow time / dwell-aware restart 用
  let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;
  let currentScope: 'main' | 'task' | 'system' | null = null;

  const guardWrite = (method: string) => {
    if (currentScope === 'task') {
      try {
        deps.audit.write(
          VIEWPORT_AUDIT_EVENTS.UI_CROSS_POLLUTION,
          `method=${method}`,
          'source=task',
        );
      } catch { /* audit self-failure tolerated */ }
    }
  };

  const withScope = <T>(scope: 'main' | 'task' | 'system', fn: () => T): T => {
    const prev = currentScope;
    currentScope = scope;
    try { return fn(); }
    finally { currentScope = prev; }
  };

  const renderStatusFrame = () => {
    if (spinnerTimer == null) return;
    statusText = `${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]} ${statusLabel}`;
    spinnerFrame++;
    deps.updateDisplay();
  };

  const cancelPendingClear = () => {
    if (pendingClearTimer) {
      clearTimeout(pendingClearTimer);
      pendingClearTimer = null;
    }
  };

  const stopSpinnerNow = () => {
    if (spinnerTimer == null) {
      statusText = '';
      statusLabel = '';
      return;
    }
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    spinnerStopTs = Date.now();
    deps.observability?.recordSpinner('stop', statusLabel);
    statusText = '';
    statusLabel = '';
  };

  const startSpinner = (label: string) => {
    cancelPendingClear();
    if (spinnerTimer != null) {
      // 已在转：仅切 label、保 timer + dwell 起点（无缝切换 waiting_llm → running_tool）
      if (statusLabel !== label) {
        statusLabel = label;
        renderStatusFrame();
      }
      return;
    }
    // phase 881 / new.P1.2: dwell-aware restart 防 spinner cycle 闪烁
    // 若距上次 stopSpinnerNow < MIN_DWELL_MS（连续 phase 切换路径）→ continuity 保
    // 用虚拟 spinnerStartTs 让下次 stopWithDwell 仍 defer，避免 fresh dwell counter 重启
    const now = Date.now();
    // phase 899 / NEW.P1.5 sub-3: MIN_DWELL_MS≤1 boundary guard（const invariant 显式表达）
    // 触发时 `now - (MIN_DWELL_MS - 1)` 退化为 `now`（=1）或 `now+1`（<1），破 elapsed 不变量 → 早出真新 cycle
    if (MIN_DWELL_MS <= 1) {
      spinnerStartTs = now;
    } else if (spinnerStopTs !== 0 && now - spinnerStopTs < MIN_DWELL_MS) {
      // continuity 保：spinnerStartTs 不重置为 now，用虚拟 elapsed 接续上次 dwell 进度
      spinnerStartTs = now - (MIN_DWELL_MS - 1);
    } else {
      spinnerStartTs = now;
    }
    statusLabel = label;
    spinnerFrame = 0;
    deps.observability?.recordSpinner('start', label);
    spinnerTimer = setInterval(renderStatusFrame, SPINNER_INTERVAL_MS);
    spinnerTimer.unref();
    renderStatusFrame();   // 首帧立绘
  };

  const stopSpinnerWithDwell = () => {
    if (spinnerTimer == null) {
      statusText = '';
      statusLabel = '';
      return;
    }
    const elapsed = Date.now() - spinnerStartTs;
    if (elapsed >= MIN_DWELL_MS) {
      stopSpinnerNow();
      deps.updateDisplay();
      return;
    }
    cancelPendingClear();
    pendingClearTimer = setTimeout(() => {
      pendingClearTimer = null;
      // 仅当未切回 spinner 类 phase 才真清
      if (phase === 'idle' || phase === 'streaming_text') {
        stopSpinnerNow();
        deps.updateDisplay();
      }
    }, MIN_DWELL_MS - elapsed);
  };

  const enterPhase = (next: TurnUIPhase, label?: string) => {
    guardWrite(`enterPhase:${next}`);
    phase = next;
    switch (next) {
      case 'idle':
      case 'streaming_text':
        stopSpinnerWithDwell();
        break;
      case 'waiting_llm':
        startSpinner('Thinking...');
        break;
      case 'running_tool':
        startSpinner(`${label ?? 'tool'}...`);
        break;
      case 'interrupting':
        startSpinner(label ?? 'Interrupting...');
        break;
      default:
        assertNever(next);
    }
    deps.updateDisplay();
  };

  const setPreview = (text: string) => {
    guardWrite('setPreview');
    preview = text ?? '';
    deps.updateDisplay();
  };
  const clearPreview = () => {
    guardWrite('clearPreview');
    preview = '';
    deps.updateDisplay();
  };

  const appendToBuffer = (delta: string) => {
    guardWrite('appendToBuffer');
    streamingBuffer += delta ?? '';
    return streamingBuffer;
  };
  const flushStreaming = () => {
    guardWrite('flushStreaming');
    if (!streamingBuffer) {
      preview = '';
      deps.updateDisplay();   // NEW: mirror non-empty branch line 224 / 双 branch 对称 invariant
      return;
    }
    const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
    const indent = '  ';
    const content = deps.trimOutputNewlines ? streamingBuffer.trim() : streamingBuffer;
    const formatted = content
      .split('\n')
      .map((line, i) => (i === 0 ? dotPrefix : indent) + line)
      .join('\n');
    streamingBuffer = '';
    preview = '';
    deps.appendOutput('', formatted, true, indent);
    deps.updateDisplay();
  };

  const appendToThinking = (delta: string) => {
    guardWrite('appendToThinking');
    thinkingBuffer += delta ?? '';
    return thinkingBuffer;
  };
  const flushThinking = () => {
    guardWrite('flushThinking');
    if (!thinkingBuffer) return;
    const prefix = '⏺ ';
    const indent = ' '.repeat(stringWidth(prefix));
    const content = deps.trimOutputNewlines ? thinkingBuffer.trim() : thinkingBuffer;
    const formatted = content
      .split('\n')
      .map((line, i) => (i === 0 ? prefix : indent) + line)
      .join('\n');
    deps.appendOutput('\x1b[2m', formatted, true, indent);
    thinkingBuffer = '';
  };

  return {
    enterPhase,
    getPhase: () => phase,
    setPreview, clearPreview,
    getStatus: () => statusText,
    getPreview: () => preview,
    appendToBuffer, flushStreaming,
    appendToThinking, flushThinking,
    withScope,
  };
}
