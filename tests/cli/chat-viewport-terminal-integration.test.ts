/**
 * chat-viewport-terminal integration tests — Phase 1155 Step C
 *
 * Uses the real pi-tui TUI against a fake terminal to prove that
 * full redraws naturally emit CSI 3J, and that wrapping the terminal with
 * the viewport adapter removes only 3J while preserving 2J/H and
 * synchronized output markers.
 */

import { describe, it, expect } from 'vitest';
import { createScrollbackPreservingTerminal, type ViewportTerminalLike } from '../../src/viewport/chat-viewport-terminal.js';

// pi-tui is loaded lazily so the test can run without a real tty.
async function loadPiTui() {
  const mod = await import('@mariozechner/pi-tui');
  return mod;
}

function makeFakeTerminal(initialCols = 80, initialRows = 5): {
  terminal: ViewportTerminalLike;
  writes: string[];
  setSize: (cols: number, rows: number) => void;
} {
  let cols = initialCols;
  let rows = initialRows;
  const writes: string[] = [];

  const terminal: ViewportTerminalLike = {
    start: () => { /* noop */ },
    stop: () => { /* noop */ },
    drainInput: async () => { /* noop */ },
    write: (data: string) => {
      writes.push(data);
    },
    get columns() {
      return cols;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => { /* noop */ },
    hideCursor: () => { /* noop */ },
    showCursor: () => { /* noop */ },
    clearLine: () => { /* noop */ },
    clearFromCursor: () => { /* noop */ },
    clearScreen: () => { /* noop */ },
    setTitle: () => { /* noop */ },
  };

  return {
    terminal,
    writes,
    setSize: (c: number, r: number) => {
      cols = c;
      rows = r;
    },
  };
}

async function drainNextTick() {
  await new Promise<void>((resolve) => process.nextTick(resolve));
}

describe('chat-viewport-terminal integration', () => {
  it('原始 fake terminal 在 pi-tui force full redraw 中收到 3J', async () => {
    const { terminal, writes } = makeFakeTerminal(80, 5);
    const { TUI, Text } = await loadPiTui();

    const tui = new TUI(terminal);
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const text = new Text(lines.join('\n'), 0, 0);
    tui.addChild(text);

    tui.requestRender(true);
    await drainNextTick();

    expect(writes.length).toBeGreaterThan(0);
    const output = writes.join('');
    expect(output).toContain('\x1b[2J\x1b[H');
    expect(output).toContain('\x1b[3J');
    expect(output).toContain('\x1b[?2026h');
    expect(output).toContain('\x1b[?2026l');

    tui.stop();
  });

  it('adapter 包装后，pi-tui full redraw 保留 2J/H 但移除 3J', async () => {
    const { terminal: inner, writes: innerWrites } = makeFakeTerminal(80, 5);
    const terminal = createScrollbackPreservingTerminal({ inner });
    const { TUI, Text } = await loadPiTui();

    const tui = new TUI(terminal);
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const text = new Text(lines.join('\n'), 0, 0);
    tui.addChild(text);

    tui.requestRender(true);
    await drainNextTick();

    expect(innerWrites.length).toBeGreaterThan(0);
    const output = innerWrites.join('');
    expect(output).toContain('\x1b[2J\x1b[H');
    expect(output).not.toContain('\x1b[3J');
    expect(output).toContain('\x1b[?2026h');
    expect(output).toContain('\x1b[?2026l');
    expect(output).toContain('line-0');
    expect(output).toContain('line-9');

    tui.stop();
  });

  it('尺寸变化路径也会触发 full redraw 并过滤 3J', async () => {
    const { terminal: inner, writes: innerWrites, setSize } = makeFakeTerminal(80, 5);
    const terminal = createScrollbackPreservingTerminal({ inner });
    const { TUI, Text } = await loadPiTui();

    const tui = new TUI(terminal);
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const text = new Text(lines.join('\n'), 0, 0);
    tui.addChild(text);

    // 首帧渲染（无 clear）
    tui.requestRender();
    await drainNextTick();

    // 改变尺寸触发 heightChanged → fullRender(true)
    setSize(80, 6);
    tui.requestRender();
    await drainNextTick();

    const output = innerWrites.join('');
    expect(output).toContain('\x1b[2J\x1b[H');
    expect(output).not.toContain('\x1b[3J');

    tui.stop();
  });

  it('phase 1942 Step C: 有界后缀折叠（rows-1 行）不进入 extraLines > height，不产生完整 body 写出', async () => {
    const { terminal: inner, writes: innerWrites } = makeFakeTerminal(80, 24);
    const terminal = createScrollbackPreservingTerminal({ inner });
    const { TUI, Text } = await loadPiTui();

    const tui = new TUI(terminal);
    const text = new Text('', 0, 0);
    tui.addChild(text);

    // body 60 行 + 临时后缀 23 行（= rows-1，display 后缀预算上限）
    const body = Array.from({ length: 60 }, (_, i) => `body-${i}`);
    const suffix = Array.from({ length: 23 }, (_, i) => `suffix-${i}`);
    text.setText([...body, ...suffix].join('\n'));
    tui.requestRender();
    await drainNextTick();

    innerWrites.length = 0;
    // 折叠：后缀从 23 行 → 0（删除行数 23 < 屏高 24 → 小清行路径）
    text.setText(body.join('\n'));
    tui.requestRender();
    await drainNextTick();

    const collapse = innerWrites.join('');
    expect(collapse).not.toContain('\x1b[2J');          // 不整帧
    expect(collapse).not.toContain('\x1b[3J');
    expect(collapse).not.toContain('body-0');          // 不重写完整 body
    expect(collapse.length).toBeLessThan(2000);        // 有界清行量级

    tui.stop();
  });
});
