/**
 * chat-viewport-terminal tests — Phase 1155 Step B
 *
 * Byte-level verification of the scrollback-preserving terminal adapter.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createScrollbackPreservingTerminal,
  type ViewportTerminalLike,
} from '../../src/viewport/chat-viewport-terminal.js';

const TARGET = '\x1b[3J';

function makeFakeTerminal(): {
  terminal: ViewportTerminalLike;
  writes: string[];
  flushed: boolean;
} {
  const writes: string[] = [];
  let flushed = false;

  const terminal: ViewportTerminalLike = {
    start: vi.fn(),
    stop: () => {
      flushed = true;
    },
    drainInput: vi.fn(async () => { /* noop */ }),
    write: (data: string) => {
      writes.push(data);
    },
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: (lines: number) => {
      writes.push(`\x1b[${lines}B`);
    },
    hideCursor: () => {
      writes.push('\x1b[?25l');
    },
    showCursor: () => {
      writes.push('\x1b[?25h');
    },
    clearLine: () => {
      writes.push('\x1b[2K');
    },
    clearFromCursor: () => {
      writes.push('\x1b[0J');
    },
    clearScreen: () => {
      writes.push('\x1b[2J\x1b[H');
    },
    setTitle: (title: string) => {
      writes.push(`\x1b]0;${title}\x07`);
    },
  };

  return { terminal, writes, flushed };
}

describe('chat-viewport-terminal', () => {
  it('普通文本完全透传', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('hello world\n');
    expect(writes).toEqual(['hello world\n']);
  });

  it('单个 CSI 3J 被移除', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write(`before${TARGET}after`);
    expect(writes).toEqual(['beforeafter']);
  });

  it('多个 CSI 3J 被移除且其他字节保持顺序', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write(`a${TARGET}b${TARGET}c`);
    expect(writes).toEqual(['abc']);
  });

  it('CSI 3J 跨 2 个 write chunk 仍被移除', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('\x1b[3');
    wrapped.write('J');
    expect(writes).toEqual([]);
  });

  it('CSI 3J 跨 3 个 write chunk 仍被移除', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('\x1b');
    wrapped.write('[3');
    wrapped.write('J');
    expect(writes).toEqual([]);
  });

  it('CSI 3J 跨 4 个 write chunk 仍被移除', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('\x1b');
    wrapped.write('[');
    wrapped.write('3');
    wrapped.write('J');
    expect(writes).toEqual([]);
  });

  it('跨 chunk 移除后，后续普通字节继续透传', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('pre\x1b[3');
    wrapped.write('Jpost');
    expect(writes).toEqual(['pre', 'post']);
  });

  it('相似序列 CSI 2J 不被误删', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    const data = '\x1b[2J\x1b[H';
    wrapped.write(data);
    expect(writes).toEqual([data]);
  });

  it('相似序列 CSI 30J 不被误删', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    const data = '\x1b[30J';
    wrapped.write(data);
    expect(writes).toEqual([data]);
  });

  it('字面量 [3J（无 ESC）不被误删', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('[3J');
    expect(writes).toEqual(['[3J']);
  });

  it('ESC 前缀未形成 TARGET 时最终 flush', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('a\x1b');
    wrapped.write('X');
    expect(writes).toEqual(['a', '\x1bX']);
  });

  it('stop 前 flush 未完成的普通前缀', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('a\x1b');
    wrapped.stop();
    // 'a' 已作为安全字节输出，'\x1b' 是潜在前缀被保留，stop 将其 flush
    expect(writes).toEqual(['a', '\x1b']);
  });

  it('moveBy 前 flush 未完成前缀并保持顺序', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('a\x1b');
    wrapped.moveBy(2);
    expect(writes).toEqual(['a', '\x1b', '\x1b[2B']);
  });

  it('hideCursor / showCursor / clearLine / clearFromCursor / clearScreen / setTitle 前均 flush', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('pre\x1b[');
    wrapped.hideCursor();
    wrapped.showCursor();
    wrapped.clearLine();
    wrapped.clearFromCursor();
    wrapped.clearScreen();
    wrapped.setTitle('x');
    // 'pre' 安全字节先输出，'\x1b[' 作为潜在前缀保留，delegate 前 flush
    expect(writes).toEqual([
      'pre',
      '\x1b[',
      '\x1b[?25l',
      '\x1b[?25h',
      '\x1b[2K',
      '\x1b[0J',
      '\x1b[2J\x1b[H',
      '\x1b]0;x\x07',
    ]);
  });

  it('onSuppress 回调返回本次 write 的抑制数量，0 不回调', () => {
    const { terminal } = makeFakeTerminal();
    const onSuppress = vi.fn();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal, onSuppress });

    wrapped.write('hello');
    expect(onSuppress).not.toHaveBeenCalled();

    wrapped.write(`${TARGET}${TARGET}`);
    expect(onSuppress).toHaveBeenCalledTimes(1);
    expect(onSuppress).toHaveBeenLastCalledWith(2);

    wrapped.write(`a${TARGET}b${TARGET}c${TARGET}`);
    expect(onSuppress).toHaveBeenCalledTimes(2);
    expect(onSuppress).toHaveBeenLastCalledWith(3);
  });

  it('inner.write 抛出的异常原样传播', () => {
    const inner = makeFakeTerminal().terminal;
    inner.write = () => {
      throw new Error('terminal write failed');
    };
    const wrapped = createScrollbackPreservingTerminal({ inner });
    expect(() => wrapped.write('hello')).toThrow('terminal write failed');
  });

  it('inner getter 直接委托', () => {
    const inner = makeFakeTerminal().terminal;
    const wrapped = createScrollbackPreservingTerminal({ inner });
    expect(wrapped.columns).toBe(80);
    expect(wrapped.rows).toBe(24);
    expect(wrapped.kittyProtocolActive).toBe(false);
  });

  it('start / drainInput 直接委托且不触发 flush', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    wrapped.write('carry\x1b');
    const onInput = vi.fn();
    const onResize = vi.fn();
    wrapped.start(onInput, onResize);
    expect(terminal.start).toHaveBeenCalledWith(onInput, onResize);
    // 'carry' 是安全字节已被输出；'\x1b' 作为潜在前缀保留，start 不 flush
    expect(writes).toEqual(['carry']);
  });

  it('真实 pi-tui fullRender 字节流中仅 3J 消失，2J/H 保留', () => {
    const { terminal, writes } = makeFakeTerminal();
    const wrapped = createScrollbackPreservingTerminal({ inner: terminal });
    const input = '\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jline1\r\nline2\x1b[?2026l';
    wrapped.write(input);
    expect(writes).toEqual(['\x1b[?2026h\x1b[2J\x1b[Hline1\r\nline2\x1b[?2026l']);
  });
});
