/**
 * Viewport terminal adapter.
 *
 * Wraps a pi-tui Terminal-compatible object and removes the exact CSI `3J`
 * sequence (clear scrollback / saved lines) from all `write()` byte streams.
 * All other bytes — including `2J`, `H`, cursor movement, synchronized output
 * markers, etc. — are preserved in order.
 *
 * This is a CLI host-compatibility boundary: the decision to preserve
 * scrollback belongs to the viewport terminal adapter, not to stream/preview
 * business logic and not to the external TUI dependency.
 */

const TARGET = '\x1b[3J';

/**
 * Minimal mirror of the pi-tui Terminal surface used by the chat viewport.
 * Keeping this interface local decouples the adapter from pi-tui internals.
 */
export interface ViewportTerminalLike {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  get kittyProtocolActive(): boolean;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
  setTitle(title: string): void;
}

interface ScrollbackPreservingTerminalOptions {
  inner: ViewportTerminalLike;
  onSuppress?: (count: number) => void;
  /** phase 1874 Step D: 宿主输入分类计数回传（诊断证据；内容不经此面）。 */
  onInput?: (counts: HostInputCounts) => void;
  /** phase 1874 Step D: 全屏清除序列（CSI 2J）计数回传（输入区/画面全量重绘相关证据）。 */
  onScreenClear?: (count: number) => void;
}

/**
 * Compute the longest suffix of `s` that is also a proper prefix of TARGET.
 * Used to carry potential split escape sequences across write chunks.
 */
function longestTargetPrefixSuffix(s: string): string {
  let carry = '';
  // TARGET.length - 1 because we only keep *proper* prefixes; a full TARGET
  // would have been removed already.
  for (let len = 1; len < TARGET.length; len++) {
    if (s.endsWith(TARGET.slice(0, len))) {
      carry = TARGET.slice(0, len);
    }
  }
  return carry;
}

/**
 * Remove every exact TARGET occurrence from `combined` and return the clean
 * output, the number of suppressed sequences, and the bytes that must be held
 * as a carry for the next write.
 */
function filterTarget(combined: string): {
  output: string;
  carry: string;
  count: number;
} {
  let count = 0;
  let output = '';
  let i = 0;

  while (i < combined.length) {
    if (combined.substring(i, i + TARGET.length) === TARGET) {
      count += 1;
      i += TARGET.length;
      continue;
    }
    output += combined[i];
    i += 1;
  }

  const carry = longestTargetPrefixSuffix(output);
  if (carry.length > 0) {
    output = output.slice(0, -carry.length);
  }

  return { output, carry, count };
}


/** 宿主输入分类计数（phase 1874 Step D：证据面——不含内容，仅分类与计数）。 */
export interface HostInputCounts {
  chunks: number;
  printable: number;
  control: number;
  mouse: number;
  escape: number;
  paste: number;
}

/**
 * 终端输入分类（纯函数）：用户按键/鼠标/输入法提交文本经终端以字节流转入。
 * 只统计类别与数量、**不保留任何内容**（诊断证据的隐私边界）。
 * - mouse: SGR 鼠标 CSI `<...M|m`；paste: bracketed paste 标记 `200~`/`201~`
 * - escape: 其余 CSI/ESC/OSC 序列（按序列计）；control: C0 单字符；printable: 其余码点
 */
export function classifyTerminalInput(data: string): HostInputCounts {
  const counts: HostInputCounts = { chunks: 1, printable: 0, control: 0, mouse: 0, escape: 0, paste: 0 };
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === '\x1b' && data[i + 1] === '[') {
      // CSI 序列：ESC [ ... final(0x40-0x7E)
      let j = i + 2;
      while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j += 1;
      const seq = data.slice(i, Math.min(j + 1, data.length));
      if (/^\x1b\[<\d+(;\d+)*[Mm]$/.test(seq)) counts.mouse += 1;
      else if (seq === '\x1b[200~' || seq === '\x1b[201~') counts.paste += 1;
      else counts.escape += 1;
      i = j + 1;
      continue;
    }
    if (ch === '\x1b') {
      // 非 CSI 的 ESC 序列（SS3 / OSC 等）：按 2 字节最小单位计一段
      let j = i + 1;
      if (data[j] === ']') {
        j += 1;
        while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j += 1;
        j += data[j] === '\x07' ? 1 : 2;
      } else {
        j = Math.min(i + 2, data.length);
      }
      counts.escape += 1;
      i = j;
      continue;
    }
    if (code < 0x20 || code === 0x7f) counts.control += 1;
    else counts.printable += 1;
    i += 1;
  }
  return counts;
}

/**
 * Create a terminal wrapper that strips CSI `3J` from writes.
 */
export function createScrollbackPreservingTerminal(
  opts: ScrollbackPreservingTerminalOptions,
): ViewportTerminalLike {
  const { inner, onSuppress, onInput, onScreenClear } = opts;
  let pending = '';

  const flushPending = () => {
    if (pending.length > 0) {
      inner.write(pending);
      pending = '';
    }
  };

  const wrapper: ViewportTerminalLike = {
    start: (onInputCb, onResize) => {
      inner.start((data) => {
        // phase 1874 Step D: 分类计数旁路（数据原样传递；证据不含内容）
        if (onInput) {
          try { onInput(classifyTerminalInput(data)); } catch { /* silent: 诊断旁路失败不影响输入路径 */ }
        }
        onInputCb(data);
      }, onResize);
    },

    stop: () => {
      flushPending();
      inner.stop();
    },

    drainInput: (maxMs, idleMs) => inner.drainInput(maxMs, idleMs),

    write: (data: string) => {
      const combined = pending + data;
      // phase 1874 Step D: CSI 2J（全屏清除）计数——输入区/画面全量重绘的证据面。
      // 跨 chunk 拆分窗口极窄（carry 仅持 3J 前缀）；诊断用途下允许极少漏计。
      const clearCount = combined.split('\x1b[2J').length - 1;
      if (clearCount > 0) {
        onScreenClear?.(clearCount);
      }
      const { output, carry, count } = filterTarget(combined);
      if (count > 0) {
        onSuppress?.(count);
      }
      pending = carry;
      if (output.length > 0) {
        inner.write(output);
      }
    },

    get columns() {
      return inner.columns;
    },

    get rows() {
      return inner.rows;
    },

    get kittyProtocolActive() {
      return inner.kittyProtocolActive;
    },

    moveBy: (lines: number) => {
      flushPending();
      inner.moveBy(lines);
    },

    hideCursor: () => {
      flushPending();
      inner.hideCursor();
    },

    showCursor: () => {
      flushPending();
      inner.showCursor();
    },

    clearLine: () => {
      flushPending();
      inner.clearLine();
    },

    clearFromCursor: () => {
      flushPending();
      inner.clearFromCursor();
    },

    clearScreen: () => {
      flushPending();
      inner.clearScreen();
    },

    setTitle: (title: string) => {
      flushPending();
      inner.setTitle(title);
    },
  };

  return wrapper;
}
