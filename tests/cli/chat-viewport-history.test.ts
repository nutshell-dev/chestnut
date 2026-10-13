/**
 * Phase 1937 Step B: viewport history window model tests.
 *
 * 验收锚点：窗口渲染输入受高度约束（10 万行合成历史下窗口行数 = 请求高度）；
 * 历史内容可由窗口游标读取；follow-tail / 滚动 / 未读 / resize 锚点 / cap 裁剪
 * 语义确定；损坏行返回 typed failure 且游标保留（不静默丢弃）。
 */

import { describe, it, expect } from 'vitest';
import { createViewportHistory, OUTPUT_LINES_CAP, MIN_HISTORY_WINDOW_LINES } from '../../src/viewport/chat-viewport-history.js';

const ok = (w: ReturnType<ReturnType<typeof createViewportHistory>['renderWindow']>) => {
  if (w.kind !== 'ok') throw new Error(`expected ok window, got failed: ${w.reason}`);
  return w;
};

describe('chat-viewport-history (phase 1937 Step B)', () => {
  it('窗口渲染输入受高度约束：10 万行合成历史仍只物化/返回窗口高度行', () => {
    const h = createViewportHistory({ cap: 100_000 });
    for (let i = 0; i < 100_000; i++) h.append({ color: '', text: `line ${i}` });

    const w = ok(h.renderWindow(80, 12));
    expect(w.lines.length).toBe(12);
    expect(w.totalLines).toBe(100_000);
    expect(w.firstVisibleLine).toBe(100_000 - 12);
    expect(w.lines[0]).toBe('line 99988');
    expect(w.lines[11]).toBe('line 99999');
    expect(w.followTail).toBe(true);
  });

  it('默认 cap 沿用 5000：超限裁剪最旧行', () => {
    const h = createViewportHistory();
    expect(OUTPUT_LINES_CAP).toBe(5000);
    for (let i = 0; i < OUTPUT_LINES_CAP + 25; i++) h.append({ color: '', text: `L${i}` });
    expect(h.logicalCount()).toBe(OUTPUT_LINES_CAP);
    const w = ok(h.renderWindow(80, 3));
    expect(w.lines).toEqual(['L5022', 'L5023', 'L5024']);
  });

  it('follow-tail：新追加推动窗口到底部', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 50; i++) h.append({ color: '', text: `L${i}` });
    let w = ok(h.renderWindow(80, 10));
    expect(w.lines[0]).toBe('L40');

    h.append({ color: '', text: 'L50' });
    w = ok(h.renderWindow(80, 10));
    expect(w.lines[0]).toBe('L41');
    expect(w.lines[9]).toBe('L50');
    expect(w.followTail).toBe(true);
  });

  it('浏览历史：新追加不移动窗口，只累计未读；回到底部恢复 follow-tail', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 50; i++) h.append({ color: '', text: `L${i}` });

    ok(h.renderWindow(80, 10));    // 先建立物化与窗口几何
    h.scrollUp(5);
    let w = ok(h.renderWindow(80, 10));
    expect(w.lines[0]).toBe('L35');
    expect(w.followTail).toBe(false);
    expect(w.unreadLines).toBe(0);
    expect(w.hasNewer).toBe(true);

    h.append({ color: '', text: 'L50' });
    h.append({ color: '', text: 'L51' });
    expect(h.unreadLines()).toBe(2);
    w = ok(h.renderWindow(80, 10));
    expect(w.lines[0]).toBe('L35');   // 窗口内容不漂移
    expect(w.unreadLines).toBe(2);
    expect(w.hasNewer).toBe(true);

    h.toBottom();
    w = ok(h.renderWindow(80, 10));
    expect(w.lines[9]).toBe('L51');
    expect(w.followTail).toBe(true);
    expect(w.unreadLines).toBe(0);
  });

  it('scrollDown 到末尾自动恢复 follow-tail 并清零未读', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 50; i++) h.append({ color: '', text: `L${i}` });

    ok(h.renderWindow(80, 10));
    h.scrollUp(30);
    h.append({ color: '', text: 'L50' });
    expect(h.isFollowingTail()).toBe(false);
    expect(h.unreadLines()).toBe(1);

    h.scrollDown(1000);
    expect(h.isFollowingTail()).toBe(true);
    expect(h.unreadLines()).toBe(0);
    const w = ok(h.renderWindow(80, 10));
    expect(w.lines[9]).toBe('L50');
  });

  it('pageUp/pageDown 按窗口高度翻页（overlap 1 行）', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 100; i++) h.append({ color: '', text: `L${i}` });

    ok(h.renderWindow(80, 10));    // L90..L99, visible=10
    h.pageUp();                    // 上翻 9 行 → start 81
    let w = ok(h.renderWindow(80, 10));
    expect(w.lines[0]).toBe('L81');
    expect(w.followTail).toBe(false);

    h.pageDown();                  // 下翻 9 行 → 回到底部
    w = ok(h.renderWindow(80, 10));
    expect(w.lines[0]).toBe('L90');
    expect(w.followTail).toBe(true);
  });

  it('toOldest 跳到最旧；顶部 clamp 不越界', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 30; i++) h.append({ color: '', text: `L${i}` });

    ok(h.renderWindow(80, 10));
    h.toOldest();
    let w = ok(h.renderWindow(80, 10));
    expect(w.firstVisibleLine).toBe(0);
    expect(w.lines[0]).toBe('L0');
    expect(w.hasOlder).toBe(false);

    h.scrollUp(1000);              // 已到顶：clamp
    w = ok(h.renderWindow(80, 10));
    expect(w.firstVisibleLine).toBe(0);
    expect(w.followTail).toBe(false);
  });

  it('高度大于历史时窗口收缩到实际行数', () => {
    const h = createViewportHistory();
    h.append({ color: '', text: 'only' });
    const w = ok(h.renderWindow(80, 10));
    expect(w.lines).toEqual(['only']);
    expect(w.visibleLineCount).toBe(1);
    expect(w.hasOlder).toBe(false);
    expect(w.hasNewer).toBe(false);
    expect(w.followTail).toBe(true);
  });

  it('高度至少 1 行（极小终端不塌缩）', () => {
    const h = createViewportHistory();
    h.append({ color: '', text: 'a' });
    h.append({ color: '', text: 'b' });
    const w = ok(h.renderWindow(80, 0));
    expect(w.lines.length).toBe(MIN_HISTORY_WINDOW_LINES);
    expect(w.lines[0]).toBe('b');
  });

  it('wrap 行按物理行计入总量与窗口', () => {
    const h = createViewportHistory();
    h.append({ color: '', text: 'x'.repeat(30), wrap: true });
    h.append({ color: '', text: 'tail' });
    const w = ok(h.renderWindow(10, 5));   // 30 宽 → 3 物理行 + 'tail' = 4
    expect(w.totalLines).toBe(4);
    expect(w.lines.length).toBe(4);
    expect(w.lines[3]).toBe('tail');
  });

  it('resize 锚点：换宽后窗口从同一逻辑行开始（不换成另一段）', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 30; i++) h.append({ color: '', text: `M${i}:` + 'x'.repeat(148), wrap: true });

    // cols=160：每逻辑行 1 物理行 → 尾部窗口 M25..M29
    let w = ok(h.renderWindow(160, 5));
    expect(w.lines[0]).toBe('M25:' + 'x'.repeat(148));

    h.scrollUp(5);                 // 上翻 5 行 → 窗口首行 = 逻辑行 M20
    w = ok(h.renderWindow(160, 5));
    expect(w.lines[0]).toBe('M20:' + 'x'.repeat(148));

    // cols=80：每逻辑行 2 物理行；窗口仍从 M20 的第一物理行开始（不换成另一段）
    w = ok(h.renderWindow(80, 5));
    expect(w.lines[0]).toBe('M20:' + 'x'.repeat(76));
    expect(w.followTail).toBe(false);
  });

  it('cap 裁剪时浏览锚点随最旧行丢弃前移（内容保持）', () => {
    const h = createViewportHistory({ cap: 10 });
    for (let i = 0; i < 15; i++) h.append({ color: '', text: `L${i}` });   // 保留 L5..L14
    ok(h.renderWindow(80, 3));     // 窗口 L12..L14
    h.scrollUp(6);                 // 窗口 L6..L8
    let w = ok(h.renderWindow(80, 3));
    expect(w.lines[0]).toBe('L6');

    for (let i = 15; i < 18; i++) h.append({ color: '', text: `L${i}` }); // 裁 L5..L7
    w = ok(h.renderWindow(80, 3));
    expect(w.lines[0]).toBe('L8'); // 同一逻辑行仍在窗口首行
    expect(w.unreadLines).toBe(3);
  });

  it('clear 清空并恢复 follow-tail', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 20; i++) h.append({ color: '', text: `L${i}` });
    ok(h.renderWindow(80, 5));
    h.scrollUp(5);
    h.clear();
    expect(h.logicalCount()).toBe(0);
    expect(h.isFollowingTail()).toBe(true);
    const w = ok(h.renderWindow(80, 5));
    expect(w.lines).toEqual([]);
  });

  it('resolvePending 去掉头部起最多 count 条 (pending) 后缀', () => {
    const h = createViewportHistory();
    h.append({ color: '', text: '> a (pending)' });
    h.append({ color: '', text: '> b (pending)' });
    h.append({ color: '', text: '> c (pending)' });
    h.resolvePending(2);
    expect(h.lines[0].text).toBe('> a');
    expect(h.lines[1].text).toBe('> b');
    expect(h.lines[2].text).toBe('> c (pending)');
  });

  it('损坏行返回 typed failure；游标状态保留（不静默丢弃、不抛）', () => {
    const h = createViewportHistory();
    h.append({ color: '', text: 'ok' });
    // 模拟未来 stream 回读/外部注入的损坏行
    (h as unknown as { append(l: unknown): void }).append({ color: '', text: 42 });

    const w = h.renderWindow(80, 5);
    expect(w.kind).toBe('failed');
    if (w.kind === 'failed') {
      expect(w.reason).toContain('logical index 1');
      expect(w.reason).not.toContain('42');   // 不回显内容（隐私边界）
    }
    expect(h.isFollowingTail()).toBe(true);    // 游标未被失败回滚
  });

  it('renderWindow 幂等：同 cols/height 重复渲染窗口一致', () => {
    const h = createViewportHistory();
    for (let i = 0; i < 40; i++) h.append({ color: '', text: `L${i}` });
    const a = ok(h.renderWindow(80, 8));
    const b = ok(h.renderWindow(80, 8));
    expect(b.lines).toEqual(a.lines);
    expect(b.firstVisibleLine).toBe(a.firstVisibleLine);
  });
});
