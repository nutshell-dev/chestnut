import { describe, expect, it, vi } from 'vitest';
import { CURSOR_MARKER, TUI, type Component } from '@mariozechner/pi-tui';

function makeHarness() {
  const writes: string[] = [];
  const terminal = {
    start: () => { /* noop */ },
    stop: () => { /* noop */ },
    drainInput: async () => { /* noop */ },
    write: (data: string) => { writes.push(data); },
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => { /* noop */ },
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: () => { /* noop */ },
    clearFromCursor: () => { /* noop */ },
    clearScreen: () => { /* noop */ },
    setTitle: () => { /* noop */ },
  };
  const tui = new TUI(terminal, true);
  let text = `ab${CURSOR_MARKER}`;
  const component: Component & { focused: boolean } = {
    focused: true,
    render: () => [text],
    invalidate: () => { /* noop */ },
  };
  tui.addChild(component);
  tui.setFocus(component);
  return {
    tui,
    writes,
    terminal,
    setText: (next: string) => { text = next; },
    reset: () => { writes.length = 0; },
  };
}

describe('Phase 2189 Step C: pi-tui frame and hardware cursor writes', () => {
  it('joins frame and cursor sequences and suppresses an unchanged cursor frame', async () => {
    const h = makeHarness();
    h.tui.requestRender();
    h.tui.flush();

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain('ab');
    expect(h.writes[0]).toContain('\x1b[3G');
    expect(h.writes[0]).toContain('\x1b[?25h');
    expect(h.writes[0]).not.toContain(CURSOR_MARKER);
    expect(h.terminal.hideCursor).not.toHaveBeenCalled();
    expect(h.terminal.showCursor).not.toHaveBeenCalled();

    h.reset();
    h.tui.requestRender();
    h.tui.flush();
    expect(h.writes).toHaveLength(0);

    await new Promise<void>(resolve => process.nextTick(resolve));
    expect(h.writes).toHaveLength(0);
  });

  it('repositions after a body write and hides when the marker disappears', () => {
    const h = makeHarness();
    h.tui.requestRender();
    h.tui.flush();
    h.reset();

    h.setText(`abcd${CURSOR_MARKER}`);
    h.tui.requestRender();
    h.tui.flush();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain('\x1b[5G');

    h.reset();
    h.setText('abcd');
    h.tui.requestRender();
    h.tui.flush();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain('\x1b[?25l');
  });

  it('keeps full-render fallback in the same single write boundary', () => {
    const h = makeHarness();
    h.tui.requestRender();
    h.tui.flush();
    h.reset();

    h.tui.requestRender(true);
    h.tui.flush();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain('\x1b[2J');
    expect(h.writes[0]).toContain('\x1b[3G');
  });
});
