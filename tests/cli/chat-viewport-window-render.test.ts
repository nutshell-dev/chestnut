/**
 * Phase 1937 Step B: display 固定窗口渲染测试。
 *
 * 验收锚点：createDisplay 注入的 history 不论多大，写入 outputText 的行数
 * 受「终端行数 − 保留区 − footer」约束；preview 有界；历史失败可见且 audit
 * 去重、成功后可恢复；滚动控制暴露 isBrowsing/提示行。
 */

import { describe, it, expect, vi } from 'vitest';
import { createDisplay } from '../../src/viewport/chat-viewport-display.js';
import { createViewportHistory } from '../../src/viewport/chat-viewport-history.js';

interface HarnessOpts {
  cols?: number;
  rows?: number;
  reserved?: number;
  mainUI?: { getStatus(): string; getPreview(): string };
  history?: ReturnType<typeof createViewportHistory>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const texts: string[] = [];
  const recordRender = vi.fn();
  const recordHistoryWindowFailed = vi.fn();
  const history = opts.history ?? createViewportHistory();
  const noopText = { setText: () => { /* noop */ } };
  const display = createDisplay({
    label: 'motion',
    outputText: { setText: (t: string) => { texts.push(t); } },
    tui: { requestRender: () => { /* noop */ } },
    observability: { recordRender, recordHistoryWindowFailed } as unknown as Parameters<typeof createDisplay>[0]['observability'],
    get mainUI() { return opts.mainUI; },
    updateClawPanel: () => { /* noop */ },
    clawTrackMap: new Map(),
    spawnText: noopText,
    shadowText: noopText,
    migratedExecText: noopText,
    taskStatusBar: { renderSpawn: () => '', renderShadow: () => '', renderMigratedExec: () => '' },
    history,
    getCols: () => opts.cols ?? 80,
    getRows: () => opts.rows ?? 30,
    getReservedRows: () => opts.reserved ?? 5,
  } as unknown as Parameters<typeof createDisplay>[0]);
  return {
    display,
    history,
    recordRender,
    recordHistoryWindowFailed,
    lastText: () => texts[texts.length - 1] ?? '',
  };
}

describe('chat-viewport-display window render (phase 1937 Step B)', () => {
  it('十万行历史只向 outputText 写入窗口行数（rows − reserved）', () => {
    const history = createViewportHistory({ cap: 100_000 });
    for (let i = 0; i < 100_000; i++) history.append({ color: '', text: `line ${i}` });
    const h = makeHarness({ history, rows: 30, reserved: 5 });

    h.display.updateDisplay();

    const lines = h.lastText().split('\n');
    expect(lines.length).toBe(25);
    expect(lines[0]).toBe('line 99975');
    expect(lines[24]).toBe('line 99999');
    expect(h.lastText()).not.toContain('line 0\n');
    const meta = h.recordRender.mock.calls.at(-1)?.[0] as { outputLines: number; windowLines: number };
    expect(meta.outputLines).toBe(100_000);
    expect(meta.windowLines).toBe(25);
  });

  it('preview 有界：超长流式文本只占可用高度 1/3（尾部）', () => {
    // 1600 字符在 cols=80 下 wrap 成 21 行（首行 80、续行带 2 列 hangIndent 各 78），
    // 远超 previewBudget = floor((30-5)/3) = 8 → 只保留尾部 8 行
    const h = makeHarness({
      rows: 30,
      reserved: 5,
      mainUI: { getStatus: () => '', getPreview: () => 'y'.repeat(1600) },
    });
    h.display.appendOutput('', 'committed');

    const lines = h.lastText().split('\n');
    expect(lines.length).toBeLessThanOrEqual(25);
    const previewTail = lines.slice(-8);
    expect(previewTail.every(l => l.startsWith('  y'))).toBe(true);
    expect(previewTail.at(-1)).toBe('  ' + 'y'.repeat(38));   // 1600 - (80 + 19*78) = 38
  });

  it('status + preview footer 计入窗口预算，总行不超屏幕', () => {
    const h = makeHarness({
      rows: 20,
      reserved: 4,
      mainUI: { getStatus: () => '⠋ Thinking...', getPreview: () => 'streaming text' },
    });
    h.display.appendOutput('', 'committed');

    const lines = h.lastText().split('\n');
    expect(lines.length).toBeLessThanOrEqual(20 - 4);
    expect(lines.at(-1)).toBe('streaming text');
    expect(lines.at(-2)).toBe('⠋ Thinking...');
  });

  it('appendOutput 追加行进窗口尾部，且不把全量历史写进 outputText', () => {
    const h = makeHarness({ rows: 10, reserved: 2 });
    for (let i = 0; i < 50; i++) h.display.appendOutput('', `L${i}`);
    const lines = h.lastText().split('\n');
    expect(lines.length).toBe(8);           // 10 - 2
    expect(lines.at(-1)).toBe('L49');
    expect(lines[0]).toBe('L42');
  });

  it('历史窗口失败：错误可见、audit 去重、恢复后再次可报', () => {
    const h = makeHarness({ rows: 10, reserved: 2 });
    h.display.appendOutput('', 'ok');
    (h.history as unknown as { append(l: unknown): void }).append({ color: '', text: 7 });

    h.display.updateDisplay();
    expect(h.lastText()).toContain('history window failed');
    expect(h.recordHistoryWindowFailed).toHaveBeenCalledTimes(1);
    expect(h.lastText()).not.toContain('7');

    h.display.updateDisplay();
    expect(h.recordHistoryWindowFailed).toHaveBeenCalledTimes(1);   // reason 未变 → 去重

    h.history.clear();
    h.display.appendOutput('', 'recovered');
    expect(h.lastText()).toContain('recovered');

    (h.history as unknown as { append(l: unknown): void }).append({ color: '', text: 8 });
    h.display.updateDisplay();
    expect(h.recordHistoryWindowFailed).toHaveBeenCalledTimes(2);   // 成功后可再报
  });

  it('滚动控制：浏览时窗口内容不漂移并显示提示行；回底恢复', () => {
    const h = makeHarness({ rows: 12, reserved: 2 });
    for (let i = 0; i < 40; i++) h.display.appendOutput('', `L${i}`);

    expect(h.display.historyControls.isBrowsing()).toBe(false);
    h.display.historyControls.scrollUp(5);
    expect(h.display.historyControls.isBrowsing()).toBe(true);

    let lines = h.lastText().split('\n');
    expect(h.lastText()).toContain('浏览历史中');
    expect(lines).toContain('L29');

    h.display.appendOutput('', 'L40');
    expect(h.lastText()).toContain('L29');          // 窗口不漂移
    expect(h.lastText()).toContain('新消息 1 行');

    h.display.historyControls.toBottom();
    expect(h.display.historyControls.isBrowsing()).toBe(false);
    lines = h.lastText().split('\n');
    expect(lines).toContain('L40');
    expect(h.lastText()).not.toContain('浏览历史中');
  });

  it('clearOutputLines 后窗口为空', () => {
    const h = makeHarness();
    h.display.appendOutput('', 'x');
    h.display.clearOutputLines();
    h.display.updateDisplay();
    expect(h.lastText()).toBe('');
  });

  it('resolvePending 修改在窗口可见行上生效', () => {
    const h = makeHarness({ rows: 10, reserved: 2 });
    h.display.appendOutput('', '> hello (pending)');
    h.display.resolvePending(1);
    expect(h.lastText()).toContain('> hello');
    expect(h.lastText()).not.toContain('(pending)');
  });
});
