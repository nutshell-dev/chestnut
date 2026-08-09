import { describe, expect, it, vi } from 'vitest';
import { createTuiInputHandler, type InputHandlerDeps } from '../../src/cli/commands/chat-viewport-input.js';

function createDeps(active = true): InputHandlerDeps {
  return {
    fs: { writeAtomicSync: vi.fn() } as unknown as InputHandlerDeps['fs'],
    audit: { write: vi.fn() } as unknown as InputHandlerDeps['audit'],
    agentDir: '/agent',
    turnTracker: {
      isActive: vi.fn(() => active),
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
  };
}

describe('chat viewport Esc input', () => {
  it('interrupts only for an exact single-byte Esc', () => {
    const deps = createDeps();

    expect(createTuiInputHandler(deps)('\x1b')).toEqual({ consume: true });

    expect(deps.fs.writeAtomicSync).toHaveBeenCalledWith('/agent/interrupt', '');
    expect(deps.turnTracker.requestInterrupt).toHaveBeenCalledWith('esc');
  });

  it.each(['\x1bf', '\x1bX', '中\x1b文'])(
    'does not treat meta/high-byte sequence %j as Esc',
    (data) => {
      const deps = createDeps();

      expect(createTuiInputHandler(deps)(data)).toBeUndefined();

      expect(deps.fs.writeAtomicSync).not.toHaveBeenCalled();
      expect(deps.turnTracker.requestInterrupt).not.toHaveBeenCalled();
    },
  );

  it('keeps the turn active and audits when the interrupt intent cannot be persisted', () => {
    const deps = createDeps();
    vi.mocked(deps.fs.writeAtomicSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(createTuiInputHandler(deps)('\x1b')).toEqual({ consume: true });

    expect(deps.audit.write).toHaveBeenCalledWith(
      'viewport_interrupt_persist_failed',
      'reason=disk full',
      'local_state=active',
    );
    expect(deps.turnTracker.requestInterrupt).not.toHaveBeenCalled();
  });
});
