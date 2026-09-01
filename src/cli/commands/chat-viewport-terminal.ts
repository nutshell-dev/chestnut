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

/**
 * Create a terminal wrapper that strips CSI `3J` from writes.
 */
export function createScrollbackPreservingTerminal(
  opts: ScrollbackPreservingTerminalOptions,
): ViewportTerminalLike {
  const { inner, onSuppress } = opts;
  let pending = '';

  const flushPending = () => {
    if (pending.length > 0) {
      inner.write(pending);
      pending = '';
    }
  };

  const wrapper: ViewportTerminalLike = {
    start: (onInput, onResize) => {
      inner.start(onInput, onResize);
    },

    stop: () => {
      flushPending();
      inner.stop();
    },

    drainInput: (maxMs, idleMs) => inner.drainInput(maxMs, idleMs),

    write: (data: string) => {
      const { output, carry, count } = filterTarget(pending + data);
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
