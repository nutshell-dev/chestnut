/**
 * Turn tracker state machine + UI cleanup
 * What: encapsulates turn lifecycle (idle → active → interrupting) + ESC timeout cleanup
 * When: turn state changes (begin/end/abort/interrupt/forceReset)
 * Why: turn logic is independently mutable (state machine changes w/o affecting display/event handling)
 */

import type { TurnTracker } from './chat-viewport.js';

export interface TurnTrackerDeps {
  mainUI: {
    enterPhase(phase: string, label?: string): void;
    flushThinking(): void;
    flushStreaming(): void;
    clearPreview(): void;
  };
  INTERRUPT_CLEANUP_TIMEOUT_MS: number;
}

export function createTurnTracker(deps: TurnTrackerDeps): TurnTracker {
  const { mainUI, INTERRUPT_CLEANUP_TIMEOUT_MS } = deps;
  type TurnPhase = 'idle' | 'active' | 'interrupting';
  let phase: TurnPhase = 'idle';
  let interruptSource: 'esc' | null = null;
  let escTimeoutId: ReturnType<typeof setTimeout> | null = null;

  const cleanupUI = () => {
    mainUI.enterPhase('idle');
    mainUI.flushThinking();
    mainUI.flushStreaming();
    mainUI.clearPreview();
  };

  const clearEscTimeout = () => {
    if (escTimeoutId) {
      clearTimeout(escTimeoutId);
      escTimeoutId = null;
    }
  };

  return {
    begin() {
      phase = 'active';
      interruptSource = null;   // 防跨 turn leak
    },
    end() {
      phase = 'idle';
      interruptSource = null;
      clearEscTimeout();
      cleanupUI();
    },
    abort() {
      phase = 'idle';
      interruptSource = null;
      clearEscTimeout();
      cleanupUI();
    },
    interrupted() {
      phase = 'idle';
      clearEscTimeout();
      cleanupUI();
      interruptSource = null;
    },
    requestInterrupt(source) {
      if (phase !== 'active') return;
      phase = 'interrupting';
      interruptSource = source;
      mainUI.enterPhase('interrupting', 'Interrupting...');
      clearEscTimeout();
      escTimeoutId = setTimeout(() => {
        escTimeoutId = null;
        if (phase === 'interrupting') {
          phase = 'idle';
          interruptSource = null;
          cleanupUI();
        }
      }, INTERRUPT_CLEANUP_TIMEOUT_MS);
    },
    forceReset() {
      phase = 'idle';
      interruptSource = null;
      clearEscTimeout();
    },
    isActive() { return phase !== 'idle'; },
    getInterruptSource() { return interruptSource; },
    destroy() { clearEscTimeout(); },
  };
}
