/**
 * chat-viewport-display tests — Phase 1942 Step C
 *
 * 临时后缀（status + preview）按终端高度有界化：
 * - 预算 = max(0, rows - 1)，在 status 与 preview 合并后计算；
 * - slice(-budget) 只保留最新可见尾部，只裁剪当前不可见的临时内容；
 * - 永久 outputLines 不截断、不移动；
 * - 后缀从任意高度折叠到空时最多删除 rows-1 行 < 屏高（不进 pi-tui 整帧重写路径）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createDisplay } from '../../src/viewport/chat-viewport-display.js';
import { createViewportObservability } from '../../src/viewport/chat-viewport-observability.js';
import type { MainTurnUIController } from '../../src/viewport/main-turn-ui.js';

const COLS = 80;

function makeHarness() {
  const observability = createViewportObservability({ audit: { write: () => { /* noop */ } } });
  let rendered = '';
  let status = '';
  let preview = '';
  let renders = 0;
  const mainUI = {
    getStatus: () => status,
    getPreview: () => preview,
  } as unknown as MainTurnUIController;
  const display = createDisplay({
    label: 'test',
    outputText: { setText: (t: string) => { rendered = t; renders += 1; } },
    tui: { requestRender: () => { /* noop */ } },
    observability,
    mainUI,
    updateClawPanel: () => { /* noop */ },
    clawTrackMap: new Map(),
    spawnText: { setText: () => { /* noop */ } },
    shadowText: { setText: () => { /* noop */ } },
    migratedExecText: { setText: () => { /* noop */ } },
    taskStatusBar: { renderSpawn: () => '', renderShadow: () => '', renderMigratedExec: () => '' },
  });
  return {
    display,
    get rendered() { return rendered; },
    get renders() { return renders; },
    setStatus: (s: string) => { status = s; },
    setPreview: (p: string) => { preview = p; },
  };
}

/** 设置 stdout 尺寸（测试后恢复） */
const descCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
const descRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
function setSize(cols: number, rows: number) {
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
}
afterEach(() => {
  if (descCols) Object.defineProperty(process.stdout, 'columns', descCols);
  else delete (process.stdout as { columns?: number }).columns;
  if (descRows) Object.defineProperty(process.stdout, 'rows', descRows);
  else delete (process.stdout as { rows?: number }).rows;
});

function bodyLineCount(rendered: string): number {
  return rendered.split('\n').length;
}

describe('phase 1942 Step C: 临时后缀高度有界化', () => {
  it('超长 preview（30 行，屏高 24）被截到 rows-1=23 行，保留最新尾部', () => {
    setSize(COLS, 24);
    const h = makeHarness();
    h.setPreview(Array.from({ length: 30 }, (_, i) => `preview line ${i}`).join('\n'));
    h.display.updateDisplay();

    const lines = h.rendered.split('\n');
    // body 1 行（初始 watching 行）+ 后缀 ≤ 23 行
    expect(lines.length).toBe(1 + 23);
    // 保留最新可见尾部：最后一条 preview 行可见，最早被裁
    expect(lines.at(-1)).toContain('preview line 29');
    expect(h.rendered).not.toContain('preview line 6');
  });

  it('status + preview 合并后统一预算：status 行在前，超限先丢最早的行', () => {
    setSize(COLS, 24);
    const h = makeHarness();
    h.setStatus('⠋ Thinking...');
    h.setPreview(Array.from({ length: 30 }, (_, i) => `p${i}`).join('\n'));
    h.display.updateDisplay();

    const lines = h.rendered.split('\n');
    expect(lines.length).toBe(1 + 23);
    expect(lines.at(-1)).toContain('p29');
    // 预算内优先保留尾部 preview；status 行被挤出
    expect(h.rendered).not.toContain('Thinking...');
  });

  it('折叠恢复：preview 清空后输出回到纯 body（后缀 0 行）', () => {
    setSize(COLS, 24);
    const h = makeHarness();
    h.setPreview(Array.from({ length: 30 }, (_, i) => `p${i}`).join('\n'));
    h.display.updateDisplay();
    expect(h.rendered.split('\n').length).toBe(24);

    h.setPreview('');
    h.display.updateDisplay();
    expect(h.rendered).toBe('[test] Watching daemon activity...');
  });

  it('折叠删除行数 ≤ rows-1 < 屏高（不进 extraLines > height 整帧路径）', () => {
    setSize(COLS, 24);
    const h = makeHarness();
    h.setPreview(Array.from({ length: 200 }, (_, i) => `p${i}`).join('\n'));
    h.display.updateDisplay();
    const before = bodyLineCount(h.rendered);

    h.setPreview('');
    h.display.updateDisplay();
    const after = bodyLineCount(h.rendered);

    // 从任意高度折叠到空：删除行数 = 23 = rows-1 < 24（屏高）
    expect(before - after).toBe(23);
    expect(before - after).toBeLessThan(24);
  });

  it('resize 行数变化后预算重算（rows=10 → 后缀 ≤ 9 行），不截断 outputLines', () => {
    setSize(COLS, 24);
    const h = makeHarness();
    h.display.appendOutput('', 'body 1');
    h.display.appendOutput('', 'body 2');
    h.setPreview(Array.from({ length: 30 }, (_, i) => `p${i}`).join('\n'));
    h.display.updateDisplay();
    // body 3 行（含初始行）+ 23 后缀
    expect(h.rendered.split('\n').length).toBe(3 + 23);

    setSize(COLS, 10);
    h.display.onResize();
    expect(h.rendered.split('\n').length).toBe(3 + 9);
    expect(h.rendered).toContain('body 1');
    expect(h.rendered).toContain('body 2');
    // outputLines 本体未被截断
    expect(h.display.outputLines.length).toBe(3);
  });

  it('极端高度：rows=1 时预算为 0，后缀整体不渲染（不产出负预算）', () => {
    setSize(COLS, 1);
    const h = makeHarness();
    h.setStatus('⠋ Thinking...');
    h.setPreview('p1\np2');
    h.display.updateDisplay();
    expect(h.rendered).toBe('[test] Watching daemon activity...');
  });

  it('永久 outputLines 不受后缀预算影响（达到 cap 前完整保留）', () => {
    setSize(COLS, 24);
    const h = makeHarness();
    for (let i = 0; i < 100; i++) h.display.appendOutput('', `history ${i}`);
    expect(h.display.outputLines.length).toBe(101);   // 初始行 + 100
    h.setPreview(Array.from({ length: 30 }, (_, i) => `p${i}`).join('\n'));
    h.display.updateDisplay();
    expect(h.display.outputLines.length).toBe(101);   // 后缀预算不触碰永久历史
    expect(h.rendered.split('\n').length).toBe(101 + 23);
  });
});
