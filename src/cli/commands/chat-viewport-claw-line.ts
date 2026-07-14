/**
 * @module L6.CLI.ChatViewport.ClawLine
 * Claw track type + render helper for chat-viewport attach panel — 0 闭包依赖
 */

import stringWidth from 'string-width';
import { sliceFromStart, fitLine } from '../utils/string.js';
import { fmtDuration } from './chat-viewport-utils.js';

/** 单个 claw 的运行时跟踪状态 / 1:1 保 chat-viewport.ts:659-680 ClawTrack interface */
export interface ClawTrack {
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
  /** daemon 探针状态：running / starting / error / stopped */
  daemonStatus: 'running' | 'starting' | 'error' | 'stopped';

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

/** 默认 ClawTrack / 1:1 保 chat-viewport.ts:682-689 body */
export function makeClawTrack(): ClawTrack {
  return {
    fileSize: 0, leftover: '', turnCount: 0, step: 0, maxSteps: 100,
    active: false, lastError: null, hasContract: false, isAlive: false, daemonStatus: 'stopped',
    currentTool: null, toolSuccess: null, textBuffer: '', bufferType: null,
    lastOutput: '', lastInterrupted: false, referenceMs: null, clearOnNextDelta: false,
  };
}

/** 渲染 claw 状态行 / 1:1 保 chat-viewport.ts:379-433 body */
export function buildClawLine(id: string, t: ClawTrack, cols: number): string {
  // spawning / error state should be visible even when not alive
  if (t.daemonStatus === 'starting') {
    return `\x1b[38;5;220m[${id}] ⊙ starting\x1b[0m`;
  }
  if (t.daemonStatus === 'error') {
    return `\x1b[38;5;214m[${id}] ✗ daemon unreadable\x1b[0m`;
  }
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
}
