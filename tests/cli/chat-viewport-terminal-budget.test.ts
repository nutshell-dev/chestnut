/**
 * Phase 1937 Step D: 终端写出预算与回归测试。
 *
 * 使用真实 pi-tui TUI + fake terminal（经 viewport adapter）+ createDisplay
 * 全链路，断言：
 * - 单帧写出与窗口/屏幕高度相关，不随历史行数（1k → 100k）线性增长；
 * - 重复相同状态不产生写出；
 * - 滚动一屏的写出有明确上限；
 * - resize full redraw 保留 2J、过滤 3J（回归）；
 * - 输入经 adapter 转发到 TUI 监听器链（回归）；
 * - adapter onWrite 记账 = 实际转发字节；observability 批次事件可审计。
 */

import { describe, it, expect } from 'vitest';
import { createScrollbackPreservingTerminal, type ViewportTerminalLike } from '../../src/viewport/chat-viewport-terminal.js';
import { createDisplay } from '../../src/viewport/chat-viewport-display.js';
import { createViewportHistory } from '../../src/viewport/chat-viewport-history.js';
import { createViewportObservability } from '../../src/viewport/chat-viewport-observability.js';

interface RecordingTerminal {
  terminal: ViewportTerminalLike;
  writes: string[];
  bytes: number;
  writtenBytes: number[];
  setSize(cols: number, rows: number): void;
  getSize(): { cols: number; rows: number };
  sendInput(data: string): void;
  reset(): void;
}

function makeRecordingTerminal(initialCols = 80, initialRows = 24): RecordingTerminal {
  let cols = initialCols;
  let rows = initialRows;
  let onInputCb: ((data: string) => void) | null = null;
  const writes: string[] = [];
  const writtenBytes: number[] = [];
  const rec: RecordingTerminal = {
    writes,
    bytes: 0,
    writtenBytes,
    setSize: (c, r) => { cols = c; rows = r; },
    getSize: () => ({ cols, rows }),
    sendInput: (data) => onInputCb?.(data),
    reset: () => { writes.length = 0; writtenBytes.length = 0; rec.bytes = 0; },
    terminal: {
      start: (cb) => { onInputCb = cb; },
      stop: () => { /* noop */ },
      drainInput: async () => { /* noop */ },
      write: (data: string) => {
        writes.push(data);
        rec.bytes += Buffer.byteLength(data);
      },
      get columns() { return cols; },
      get rows() { return rows; },
      get kittyProtocolActive() { return false; },
      moveBy: () => { /* noop */ },
      hideCursor: () => { /* noop */ },
      showCursor: () => { /* noop */ },
      clearLine: () => { /* noop */ },
      clearFromCursor: () => { /* noop */ },
      clearScreen: () => { /* noop */ },
      setTitle: () => { /* noop */ },
    },
  };
  return rec;
}

async function drainNextTick() {
  await new Promise<void>((resolve) => process.nextTick(resolve));
}

async function makeStack(cols = 80, rows = 24) {
  const inner = makeRecordingTerminal(cols, rows);
  const forwarded: number[] = [];
  const adapter = createScrollbackPreservingTerminal({
    inner: inner.terminal,
    onWrite: (bytes) => { forwarded.push(bytes); },
  });
  const { TUI, Text } = await import('@mariozechner/pi-tui');
  const tui = new TUI(adapter);
  const outputText = new Text('', 0, 0);
  tui.addChild(outputText);
  const history = createViewportHistory({ cap: 200_000 });
  const noopText = { setText: () => { /* noop */ } };
  const display = createDisplay({
    label: 'motion',
    outputText,
    tui: { requestRender: () => tui.requestRender() },
    observability: { recordRender: () => { /* noop */ }, recordHistoryWindowFailed: () => { /* noop */ } } as unknown as Parameters<typeof createDisplay>[0]['observability'],
    updateClawPanel: () => { /* noop */ },
    clawTrackMap: new Map(),
    spawnText: noopText,
    shadowText: noopText,
    migratedExecText: noopText,
    taskStatusBar: { renderSpawn: () => '', renderShadow: () => '', renderMigratedExec: () => '' },
    history,
    getCols: () => inner.getSize().cols,
    getRows: () => inner.getSize().rows,
    getReservedRows: () => 0,
  } as unknown as Parameters<typeof createDisplay>[0]);

  tui.start();
  await drainNextTick();
  inner.reset();
  forwarded.length = 0;
  return { inner, adapter, tui, display, history, forwarded };
}

/** 单帧写出上限：屏幕行数 × 行宽 + 同步输出标记等开销。 */
function frameCeiling(cols: number, rows: number): number {
  return (rows + 4) * (cols + 8) + 128;
}

describe('chat-viewport terminal write budget (phase 1937 Step D)', () => {
  it('单帧写出受屏幕约束：历史 1k → 100k 不线性增长', async () => {
    const { inner, display, history } = await makeStack(80, 24);

    for (let i = 0; i < 1_000; i++) history.append({ color: '', text: `line ${i}` });
    display.updateDisplay();
    await drainNextTick();
    const bytes1k = inner.bytes;

    inner.reset();                    // 单帧记账：清累计，只量 100k 历史下的这一帧
    for (let i = 1_000; i < 100_000; i++) history.append({ color: '', text: `line ${i}` });
    display.updateDisplay();
    await drainNextTick();
    const bytes100k = inner.bytes;

    expect(bytes1k).toBeGreaterThan(0);
    expect(bytes1k).toBeLessThanOrEqual(frameCeiling(80, 24));
    expect(bytes100k).toBeLessThanOrEqual(frameCeiling(80, 24));
    // 历史涨 100 倍，单帧写出不随之增长（允许小的布局差异余量）
    expect(bytes100k).toBeLessThanOrEqual(bytes1k * 1.5 + 64);
  });

  it('重复相同状态不产生写出', async () => {
    const { inner, display, history } = await makeStack(80, 24);
    for (let i = 0; i < 200; i++) history.append({ color: '', text: `line ${i}` });
    display.updateDisplay();
    await drainNextTick();
    expect(inner.bytes).toBeGreaterThan(0);

    inner.reset();
    display.updateDisplay();          // 内容无变化
    await drainNextTick();
    expect(inner.bytes).toBe(0);
  });

  it('滚动一屏写出有明确上限（≈ 一屏内容重绘）', async () => {
    const { inner, display, history } = await makeStack(80, 24);
    for (let i = 0; i < 5_000; i++) history.append({ color: '', text: `line ${i}` });
    display.updateDisplay();
    await drainNextTick();

    inner.reset();
    display.historyControls.pageUp();
    await drainNextTick();
    expect(inner.bytes).toBeGreaterThan(0);
    expect(inner.bytes).toBeLessThanOrEqual(frameCeiling(80, 24));

    inner.reset();
    display.historyControls.toBottom();
    await drainNextTick();
    expect(inner.bytes).toBeLessThanOrEqual(frameCeiling(80, 24));
  });

  it('resize 触发 full redraw：保留 2J、过滤 3J（回归）', async () => {
    const { inner, display, history } = await makeStack(80, 24);
    for (let i = 0; i < 500; i++) history.append({ color: '', text: `line ${i}` });
    display.updateDisplay();
    await drainNextTick();

    inner.reset();
    inner.setSize(80, 12);
    display.onResize();
    await drainNextTick();

    const output = inner.writes.join('');
    expect(output).toContain('\x1b[2J\x1b[H');
    expect(output).not.toContain('\x1b[3J');
    // 新高度下写出同样受屏幕约束
    expect(inner.bytes).toBeLessThanOrEqual(frameCeiling(80, 12));
  });

  it('输入经 adapter 转发到 TUI 监听器链（回归）', async () => {
    const { inner, tui } = await makeStack(80, 24);
    const seen: string[] = [];
    tui.addInputListener((data) => { seen.push(data); return undefined; });

    inner.sendInput('hello');
    expect(seen).toContain('hello');
    inner.sendInput('\x1b[5~');
    expect(seen).toContain('\x1b[5~');
    tui.stop();
  });

  it('adapter onWrite 记账 = 实际转发字节（含跨 chunk carry 不计）', async () => {
    const { inner, display, history, forwarded } = await makeStack(80, 24);
    for (let i = 0; i < 300; i++) history.append({ color: '', text: `line ${i}` });
    display.updateDisplay();
    await drainNextTick();

    const forwardedTotal = forwarded.reduce((a, b) => a + b, 0);
    expect(forwardedTotal).toBe(inner.bytes);
  });
});

describe('terminal write observability (phase 1937 Step D)', () => {
  it('recordTerminalWrite 批次事件：chunks/bytes/max_chunk，关停时兜底 flush', () => {
    const auditCalls: unknown[][] = [];
    const obs = createViewportObservability({
      audit: { write: (...args: unknown[]) => { auditCalls.push(args); } },
    });
    obs.recordTerminalWrite(100);
    obs.recordTerminalWrite(50);
    obs.recordShutdown('user_quit');

    const batch = auditCalls.find(c => c[0] === 'viewport_terminal_write_batch');
    expect(batch).toBeDefined();
    expect(batch).toContain('chunks=2');
    expect(batch).toContain('bytes=150');
    expect(batch).toContain('max_chunk=100');
  });

  it('批量阈值触发 flush（20 次写出）', () => {
    const auditCalls: unknown[][] = [];
    const obs = createViewportObservability({
      audit: { write: (...args: unknown[]) => { auditCalls.push(args); } },
    });
    for (let i = 0; i < 20; i++) obs.recordTerminalWrite(10);
    const batches = auditCalls.filter(c => c[0] === 'viewport_terminal_write_batch');
    expect(batches.length).toBe(1);
    expect(batches[0]).toContain('chunks=20');
    expect(batches[0]).toContain('bytes=200');
  });
});
