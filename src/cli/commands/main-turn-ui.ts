/**
 * @module L6.CLI.ChatViewport.MainTurnUI
 * Main turn UI controller — spinner + streaming buffer + thinking buffer
 *
 * Migrated from chat-viewport.ts:101-235 (phase 484 Step B)
 * 0 闭包依赖 / 接受 MainTurnUIDeps 参 / 已是 phase 72 后的独立工厂模式
 */

import stringWidth from 'string-width';
import type { AuditWriter } from '../../foundation/audit/writer.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

export interface MainTurnUIDeps {
  appendOutput: (color: string, text: string, wrap?: boolean, hangIndent?: string) => void;
  updateDisplay: () => void;
  trimOutputNewlines: boolean;
  getThinkingMode: () => 'compact' | 'full' | 'off';
  audit: AuditWriter;
  observability?: { recordSpinner: (action: 'start' | 'stop', text: string) => void };
}

export interface MainTurnUIController {
  setSuffix(text: string): void;
  clearSuffix(): void;
  getSuffix(): string;
  startSpinner(text?: string): void;
  stopSpinner(): void;
  appendToBuffer(delta: string): string;
  flushStreaming(): void;
  appendToThinking(delta: string): string;
  flushThinking(): void;
  withScope<T>(scope: 'main' | 'task' | 'system', fn: () => T): T;
}

// Braille spinner 动画
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createMainTurnUI(deps: MainTurnUIDeps): MainTurnUIController {
  let suffix = '';
  let streamingBuffer = '';
  let thinkingBuffer = '';
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let currentScope: 'main' | 'task' | 'system' | null = null;
  let currentSpinnerText = 'Thinking...';

  const guardWrite = (method: string) => {
    if (currentScope === 'task') {
      try {
        deps.audit.write(
          VIEWPORT_AUDIT_EVENTS.UI_CROSS_POLLUTION,
          `method=${method}`,
          'source=task',
        );
      } catch { /* audit self-failure is tolerated */ }
    }
  };

  const withScope = <T>(scope: 'main' | 'task' | 'system', fn: () => T): T => {
    const prev = currentScope;
    currentScope = scope;
    try { return fn(); }
    finally { currentScope = prev; }
  };

  const setSuffix = (text: string) => {
    guardWrite('setSuffix');
    suffix = text ?? '';
    deps.updateDisplay();
  };
  const clearSuffix = () => {
    guardWrite('clearSuffix');
    suffix = '';
    deps.updateDisplay();
  };
  const getSuffix = () => suffix;

  const stopSpinner = () => {
    guardWrite('stopSpinner');
    if (spinnerTimer == null) return;
    
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    deps.observability?.recordSpinner('stop', currentSpinnerText);
  };
  const startSpinner = (text = 'Thinking...') => {
    guardWrite('startSpinner');
    stopSpinner();
    currentSpinnerText = text;
    deps.observability?.recordSpinner('start', text);
    let frame = 0;
    spinnerTimer = setInterval(() => {
      suffix = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text}`;
      deps.updateDisplay();
      frame++;
    }, 80);
    spinnerTimer.unref();
    // 立即显示第一帧
    setSuffix(`${SPINNER_FRAMES[0]} ${text}`);
  };

  const appendToBuffer = (delta: string) => {
    guardWrite('appendToBuffer');
    streamingBuffer += delta ?? '';
    return streamingBuffer;
  };
  const flushStreaming = () => {
    guardWrite('flushStreaming');
    if (!streamingBuffer) return;
    const dotPrefix = '\x1b[38;5;232m⏺\x1b[0m ';
    const indent = '  ';
    const content = deps.trimOutputNewlines ? streamingBuffer.trim() : streamingBuffer;
    const formatted = content
      .split('\n')
      .map((line, i) => (i === 0 ? dotPrefix : indent) + line)
      .join('\n');
    streamingBuffer = '';
    suffix = '';
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
    setSuffix, clearSuffix, getSuffix,
    startSpinner, stopSpinner,
    appendToBuffer, flushStreaming,
    appendToThinking, flushThinking,
    withScope,
  };
}
