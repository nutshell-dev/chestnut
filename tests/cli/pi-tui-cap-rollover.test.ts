/**
 * pi-tui-cap-rollover tests — Phase 1942 Step C
 *
 * pi-tui patch（patches/@mariozechner__pi-tui@0.58.3.patch）cap 单行 rollover 分支：
 * - 5000 行 cap 后「旧首行移出、末行追加」→ 1 次原生滚动 + 末行追加写出（无 2J、无整帧）；
 * - 非严格单行移位（多行移位 / 中间行变化）→ 保留 fullRender(true) 整帧路径；
 * - resize → 整帧重写（基线语义：2J 保留、3J 由 viewport adapter 过滤）。
 */

import { describe, it, expect } from 'vitest';
import {
  createScrollbackPreservingTerminal,
  type ViewportTerminalLike,
} from '../../src/viewport/chat-viewport-terminal.js';

function makeFakeTerminal(cols0 = 80, rows0 = 24) {
  let cols = cols0;
  let rows = rows0;
  const writes: string[] = [];
  const rec = {
    writes,
    get bytes() { return writes.join('').length; },
    setSize: (c: number, r: number) => { cols = c; rows = r; },
    reset: () => { writes.length = 0; },
    terminal: {
      start: () => { /* noop */ },
      stop: () => { /* noop */ },
      drainInput: async () => { /* noop */ },
      write: (data: string) => { writes.push(data); },
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
    } satisfies ViewportTerminalLike,
  };
  return rec;
}

const tick = () => new Promise<void>((r) => process.nextTick(r));

async function makeTui(cols = 80, rows = 24) {
  const rec = makeFakeTerminal(cols, rows);
  const adapter = createScrollbackPreservingTerminal({ inner: rec.terminal });
  const { TUI, Text } = await import('@mariozechner/pi-tui');
  const tui = new TUI(adapter);
  const outputText = new Text('', 0, 0);
  tui.addChild(outputText);
  return { rec, tui, outputText };
}

const CAP = 5000;
const line = (i: number) => `cap history line ${i}`;

describe('phase 1942 Step C: pi-tui cap rollover', () => {
  it('cap 后严格单行移位：追加写出（滚动 1 行 + 末行），无 2J 无整帧', async () => {
    const { rec, tui, outputText } = await makeTui();
    tui.start();
    // 初始帧：cap 行数 body
    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i)).join('\n'));
    tui.requestRender();
    await tick();
    rec.reset();

    // 严格单行移位：splice(0,1) + push
    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i + 1)).join('\n'));
    tui.requestRender();
    await tick();

    const joined = rec.writes.join('');
    expect(joined).not.toContain('\x1b[2J');          // 不整帧
    expect(joined).not.toContain('\x1b[3J');
    expect(joined).toContain(line(CAP));              // 末行追加可见
    expect(joined).not.toContain(line(0));            // 不重新写出被移出的旧首行（经滚动入 scrollback）
    // 有界：单帧写出 ~ 行宽量级，远小于整帧（5000 行 × ~40 字节）
    expect(rec.bytes).toBeLessThan(2000);
    tui.stop();
  }, 30_000);

  it('cap 后连续多次单行移位均走追加写出', async () => {
    const { rec, tui, outputText } = await makeTui();
    tui.start();
    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i)).join('\n'));
    tui.requestRender();
    await tick();
    rec.reset();

    for (let k = 1; k <= 5; k++) {
      outputText.setText(Array.from({ length: CAP }, (_, i) => line(i + k)).join('\n'));
      tui.requestRender();
      await tick();
    }

    const joined = rec.writes.join('');
    expect(joined).not.toContain('\x1b[2J');
    expect(joined).toContain(line(CAP + 4));
    expect(rec.bytes).toBeLessThan(5 * 2000);
    tui.stop();
  }, 30_000);

  it('非单行移位（一次移 2 行）→ 回退 fullRender 整帧（正确性优先）', async () => {
    const { rec, tui, outputText } = await makeTui();
    tui.start();
    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i)).join('\n'));
    tui.requestRender();
    await tick();
    rec.reset();

    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i + 2)).join('\n'));
    tui.requestRender();
    await tick();

    const joined = rec.writes.join('');
    expect(joined).toContain('\x1b[2J');              // 兜底整帧保留
    expect(joined).not.toContain('\x1b[3J');          // adapter 3J 过滤不变
    expect(joined).toContain(line(CAP + 1));
    tui.stop();
  }, 30_000);

  it('同长度但中间行变化（非纯移位）→ 回退 fullRender 整帧', async () => {
    const { rec, tui, outputText } = await makeTui();
    tui.start();
    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i)).join('\n'));
    tui.requestRender();
    await tick();
    rec.reset();

    const lines = Array.from({ length: CAP }, (_, i) => line(i));
    lines[10] = 'edited middle line';                 // 中间行变化
    outputText.setText(lines.join('\n'));
    tui.requestRender();
    await tick();

    const joined = rec.writes.join('');
    expect(joined).toContain('\x1b[2J');
    expect(joined).toContain('edited middle line');
    tui.stop();
  }, 30_000);

  it('cap 状态下 resize → 整帧重写（基线语义：2J 保留、3J 过滤）', async () => {
    const { rec, tui, outputText } = await makeTui();
    tui.start();
    outputText.setText(Array.from({ length: CAP }, (_, i) => line(i)).join('\n'));
    tui.requestRender();
    await tick();
    rec.reset();

    rec.setSize(100, 30);
    tui.requestRender();
    await tick();

    const joined = rec.writes.join('');
    expect(joined).toContain('\x1b[2J');
    expect(joined).not.toContain('\x1b[3J');
    expect(joined).toContain(line(CAP - 1));
    tui.stop();
  }, 30_000);
});
