/**
 * Phase 1937 Step C: 历史滚动键交互测试。
 *
 * 验收锚点：
 * - PageUp/PageDown、Shift+Up/Shift+Down 始终作用于历史窗口（消费）；
 * - 裸 Up/Down、Home/End 仅在浏览历史（followTail=false）时接管，否则透传编辑器；
 * - 无 history 控制面时历史键不拦截（向后兼容）；
 * - 重启恢复：同一 stream 重放顺序重建的历史窗口与重启前尾部窗口一致。
 */

import { describe, it, expect, vi } from 'vitest';
import { createTuiInputHandler, parseScrollKeys, type InputHandlerDeps } from '../../src/viewport/chat-viewport-input.js';
import { createViewportHistory } from '../../src/viewport/chat-viewport-history.js';
import type { ViewportHistoryControls } from '../../src/viewport/chat-viewport-types.js';

function makeHistoryControls(browsing = false) {
  const controls: ViewportHistoryControls & {
    setBrowsing: (v: boolean) => void;
    scrollUp: ReturnType<typeof vi.fn>;
    scrollDown: ReturnType<typeof vi.fn>;
    pageUp: ReturnType<typeof vi.fn>;
    pageDown: ReturnType<typeof vi.fn>;
    toOldest: ReturnType<typeof vi.fn>;
    toBottom: ReturnType<typeof vi.fn>;
  } = {
    isBrowsing: () => browsing,
    setBrowsing: (v: boolean) => { browsing = v; },
    scrollUp: vi.fn(),
    scrollDown: vi.fn(),
    pageUp: vi.fn(),
    pageDown: vi.fn(),
    toOldest: vi.fn(),
    toBottom: vi.fn(),
  };
  return controls;
}

function createDeps(history?: ViewportHistoryControls): InputHandlerDeps {
  return {
    fs: { writeAtomicSync: vi.fn() } as unknown as InputHandlerDeps['fs'],
    audit: { write: vi.fn() } as unknown as InputHandlerDeps['audit'],
    agentDir: '/agent',
    turnTracker: {
      isActive: vi.fn(() => false),
      requestInterrupt: vi.fn(),
    } as unknown as InputHandlerDeps['turnTracker'],
    mainUI: {
      enterPhase: vi.fn(),
      clearPreview: vi.fn(),
    } as unknown as InputHandlerDeps['mainUI'],
    editor: { getText: vi.fn(() => ''), setText: vi.fn() },
    requestRender: vi.fn(),
    resolveExit: vi.fn(),
    setShutdownReason: vi.fn(),
    history,
  };
}

describe('parseScrollKeys (phase 1937 Step C)', () => {
  it('识别标准滚动键序列', () => {
    expect(parseScrollKeys('\x1b[5~')).toEqual([{ action: 'pageUp', browsingOnly: false }]);
    expect(parseScrollKeys('\x1b[6~')).toEqual([{ action: 'pageDown', browsingOnly: false }]);
    expect(parseScrollKeys('\x1b[1;2A')).toEqual([{ action: 'up', browsingOnly: false }]);
    expect(parseScrollKeys('\x1b[1;2B')).toEqual([{ action: 'down', browsingOnly: false }]);
    expect(parseScrollKeys('\x1b[A')).toEqual([{ action: 'up', browsingOnly: true }]);
    expect(parseScrollKeys('\x1b[B')).toEqual([{ action: 'down', browsingOnly: true }]);
    expect(parseScrollKeys('\x1b[H')).toEqual([{ action: 'home', browsingOnly: true }]);
    expect(parseScrollKeys('\x1b[F')).toEqual([{ action: 'end', browsingOnly: true }]);
    expect(parseScrollKeys('\x1b[1~')).toEqual([{ action: 'home', browsingOnly: true }]);
    expect(parseScrollKeys('\x1b[4~')).toEqual([{ action: 'end', browsingOnly: true }]);
    expect(parseScrollKeys('\x1bOH')).toEqual([{ action: 'home', browsingOnly: true }]);
    expect(parseScrollKeys('\x1bOF')).toEqual([{ action: 'end', browsingOnly: true }]);
  });

  it('同 chunk 重复序列逐次展开（连按 PageUp）', () => {
    expect(parseScrollKeys('\x1b[5~\x1b[5~\x1b[5~')).toEqual([
      { action: 'pageUp', browsingOnly: false },
      { action: 'pageUp', browsingOnly: false },
      { action: 'pageUp', browsingOnly: false },
    ]);
  });

  it('非滚动键／混合内容返回 undefined（透传）', () => {
    expect(parseScrollKeys('a')).toBeUndefined();
    expect(parseScrollKeys('\x1bf')).toBeUndefined();
    expect(parseScrollKeys('\x1b[Aa')).toBeUndefined();
    expect(parseScrollKeys('\x1b[5~\x1b[')).toBeUndefined();
    expect(parseScrollKeys('')).toBeUndefined();
  });
});

describe('chat-viewport scroll input (phase 1937 Step C)', () => {
  it('PageUp/PageDown 始终接管并调用历史控制', () => {
    const history = makeHistoryControls(false);
    const handler = createTuiInputHandler(createDeps(history));

    expect(handler('\x1b[5~')).toEqual({ consume: true });
    expect(history.pageUp).toHaveBeenCalledTimes(1);
    expect(handler('\x1b[6~')).toEqual({ consume: true });
    expect(history.pageDown).toHaveBeenCalledTimes(1);
  });

  it('Shift+Up/Shift+Down 始终接管（单行滚动）', () => {
    const history = makeHistoryControls(false);
    const handler = createTuiInputHandler(createDeps(history));

    expect(handler('\x1b[1;2A')).toEqual({ consume: true });
    expect(history.scrollUp).toHaveBeenCalledWith(1);
    expect(handler('\x1b[1;2B')).toEqual({ consume: true });
    expect(history.scrollDown).toHaveBeenCalledWith(1);
  });

  it('裸 Up/Down/Home/End 在 follow-tail 时透传编辑器，不接管', () => {
    const history = makeHistoryControls(false);
    const handler = createTuiInputHandler(createDeps(history));

    expect(handler('\x1b[A')).toBeUndefined();
    expect(handler('\x1b[B')).toBeUndefined();
    expect(handler('\x1b[H')).toBeUndefined();
    expect(handler('\x1b[F')).toBeUndefined();
    expect(history.scrollUp).not.toHaveBeenCalled();
    expect(history.scrollDown).not.toHaveBeenCalled();
    expect(history.toOldest).not.toHaveBeenCalled();
    expect(history.toBottom).not.toHaveBeenCalled();
  });

  it('浏览历史时裸 Up/Down/Home/End 接管：滚动与跳顶/回底', () => {
    const history = makeHistoryControls(true);
    const handler = createTuiInputHandler(createDeps(history));

    expect(handler('\x1b[A')).toEqual({ consume: true });
    expect(history.scrollUp).toHaveBeenCalledWith(1);
    expect(handler('\x1b[B')).toEqual({ consume: true });
    expect(history.scrollDown).toHaveBeenCalledWith(1);
    expect(handler('\x1b[H')).toEqual({ consume: true });
    expect(history.toOldest).toHaveBeenCalledTimes(1);
    expect(handler('\x1b[F')).toEqual({ consume: true });
    expect(history.toBottom).toHaveBeenCalledTimes(1);
  });

  it('无 history 控制面时滚动键不拦截（向后兼容）', () => {
    const handler = createTuiInputHandler(createDeps(undefined));
    expect(handler('\x1b[5~')).toBeUndefined();
    expect(handler('\x1b[A')).toBeUndefined();
  });

  it('ESC 中断、Ctrl+C/D 语义不受滚动键影响（回归）', () => {
    const history = makeHistoryControls(true);
    const deps = createDeps(history);
    const handler = createTuiInputHandler(deps);

    expect(handler('\x1b')).toEqual({ consume: true });      // idle: 清 preview
    expect(deps.mainUI.enterPhase).toHaveBeenCalledWith('idle');
    expect(handler('\x04')).toEqual({ consume: true });      // Ctrl+D 清空输入
    expect(deps.editor.setText).toHaveBeenCalledWith('');
  });
});

describe('重启恢复（phase 1937 Step C）', () => {
  it('同一 stream 重放顺序重建历史后，窗口与重启前尾部窗口一致', () => {
    const replay: Array<{ color: string; text: string }> = Array.from(
      { length: 60 },
      (_, i) => ({ color: '', text: `event-${i}` }),
    );

    const before = createViewportHistory();
    for (const l of replay) before.append(l);
    const beforeWindow = before.renderWindow(80, 12);
    if (beforeWindow.kind !== 'ok') throw new Error('unexpected failure');

    // 重启：新会话按 stream 重放顺序重建（viewport 初始化从 recent turn 起读同一 stream）
    const after = createViewportHistory();
    for (const l of replay) after.append(l);
    const afterWindow = after.renderWindow(80, 12);
    if (afterWindow.kind !== 'ok') throw new Error('unexpected failure');

    expect(afterWindow.followTail).toBe(true);
    expect(afterWindow.lines).toEqual(beforeWindow.lines);
    expect(afterWindow.firstVisibleLine).toBe(beforeWindow.firstVisibleLine);
  });
});
