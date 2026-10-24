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

import type { AuditLog } from '../foundation/audit/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import { prefixLines } from './terminal-text.js';


type TurnUIPhase =
  | 'idle'
  | 'waiting_llm'
  | 'streaming_text'
  | 'running_tool'
  | 'interrupting';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Spinner 帧切换节奏（模块内部常量）。
 */
const SPINNER_INTERVAL_MS = 80;

/**
 * Spinner 进 phase 后保证可见 dwell（ms）。dwell 内 clear 推迟兑现。
 * Exported: tests/ 镜像此契约（如 e2e 测 exceed MIN_DWELL_MS 触发 stop sync）.
 */
export const MIN_DWELL_MS = 200;

/**
 * Phase 1992：preview 语义 block。event handler 只发 {kind, text} 语义，
 * 不构造 ANSI、不读 thinking display mode——渲染规则唯一归本模块。
 */
export type PreviewBlock =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'send-content'; text: string; streaming: boolean };

/**
 * Phase 1992：preview 渲染后的逐行语义（text 已含首行前缀/续行 2 空格缩进）。
 * style 是语义 token（dim/plain），ANSI 由 Display 唯一映射。
 */
export interface PreviewLine {
  text: string;
  style: 'dim' | 'plain';
}

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
  setPreview(block: PreviewBlock | null): void;
  clearPreview(): void;
  getStatus(): string;
  getPreviewLines(): readonly PreviewLine[];
  appendToBuffer(delta: string): string;
  flushStreaming(): void;
  flushStreamingNormal(): void;
  appendToThinking(delta: string): string;
  flushThinking(): void;
  withScope<T>(scope: 'main' | 'task' | 'system', fn: () => T): T;
}

export function createMainTurnUI(deps: MainTurnUIDeps): MainTurnUIController {
  let phase: TurnUIPhase = 'idle';
  let statusLabel = '';
  let statusText = '';
  let previewLines: readonly PreviewLine[] = [];
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
        { const _exhaustive: never = next; void _exhaustive; }
    }
    deps.updateDisplay();
  };

  // Phase 1992: 唯一 block→PreviewLine[] 渲染规则（preview 与 final flush 共用）。
  const renderPreviewBlock = (
    block: PreviewBlock | null,
    opts: { trim: boolean },
  ): readonly PreviewLine[] => {
    if (!block) return [];
    const raw = opts.trim ? block.text.trim() : block.text;

    if (block.kind === 'thinking') {
      const mode = deps.getThinkingMode();
      if (mode === 'off') return [];
      if (mode === 'compact') {
        const snippet = raw.replace(/\s+/g, ' ').trim().slice(-60);
        return [{ text: `[thinking] (${snippet})`, style: 'dim' }];
      }
      return prefixLines(raw, '⏺ [thinking] ', '  ')
        .split('\n')
        .map(text => ({ text, style: 'dim' as const }));
    }

    const cursor = block.streaming ? '▋' : '';
    const prefix = block.kind === 'text' ? '⏺ ' : '➤ ';
    const style = block.kind === 'text' ? ('dim' as const) : ('plain' as const);
    return prefixLines(raw + cursor, prefix, '  ')
      .split('\n')
      .map(text => ({ text, style }));
  };

  const setPreview = (block: PreviewBlock | null) => {
    guardWrite('setPreview');
    previewLines = renderPreviewBlock(block, { trim: false });
    deps.updateDisplay();
  };
  const clearPreview = () => {
    guardWrite('clearPreview');
    previewLines = [];
    deps.updateDisplay();
  };

  // Phase 1992 Step C: flush 与 preview 共用同一 renderer 的字符串出口
  const styleColor = (style: PreviewLine['style']): string =>
    style === 'dim' ? '\x1b[2m' : '';

  const formatPreviewBlock = (block: PreviewBlock, opts: { trim: boolean }): string =>
    renderPreviewBlock(block, opts).map(line => line.text).join('\n');

  const appendToBuffer = (delta: string) => {
    guardWrite('appendToBuffer');
    streamingBuffer += delta ?? '';
    return streamingBuffer;
  };
  const flushStreaming = () => {
    guardWrite('flushStreaming');
    if (!streamingBuffer) return;
    const formatted = formatPreviewBlock(
      { kind: 'text', text: streamingBuffer, streaming: false },
      { trim: deps.trimOutputNewlines },
    );
    streamingBuffer = '';
    if (!formatted) return;
    deps.appendOutput(styleColor('dim'), formatted, true, '  ');   // appendOutput 内部已 updateDisplay
  };

  const flushStreamingNormal = () => {
    guardWrite('flushStreamingNormal');
    if (!streamingBuffer) return;
    const formatted = formatPreviewBlock(
      { kind: 'send-content', text: streamingBuffer, streaming: false },
      { trim: deps.trimOutputNewlines },
    );
    streamingBuffer = '';
    if (!formatted) return;
    deps.appendOutput(styleColor('plain'), formatted, true, '  ');
  };

  const appendToThinking = (delta: string) => {
    guardWrite('appendToThinking');
    thinkingBuffer += delta ?? '';
    return thinkingBuffer;
  };
  const flushThinking = () => {
    guardWrite('flushThinking');
    if (!thinkingBuffer) return;
    const formatted = formatPreviewBlock(
      { kind: 'thinking', text: thinkingBuffer },
      { trim: deps.trimOutputNewlines },
    );
    thinkingBuffer = '';
    if (!formatted) return;
    deps.appendOutput(styleColor('dim'), formatted, true, '  ');
  };

  return {
    enterPhase,
    getPhase: () => phase,
    setPreview, clearPreview,
    getStatus: () => statusText,
    getPreviewLines: () => previewLines,
    appendToBuffer, flushStreaming, flushStreamingNormal,
    appendToThinking, flushThinking,
    withScope,
  };
}
