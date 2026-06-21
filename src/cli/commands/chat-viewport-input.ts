import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { TurnTracker } from './chat-viewport-types.js';

export type ShutdownReason = 'daemon_dead' | 'user_quit' | 'stream_end';

export interface EditorHandle {
  getText(): string;
  setText(text: string): void;
}

export interface InputHandlerDeps {
  fs: FileSystem;
  agentDir: string;
  turnTracker: TurnTracker;
  mainUI: MainTurnUIController;
  editor: EditorHandle;
  requestRender: () => void;
  resolveExit: () => void;
  setShutdownReason: (r: ShutdownReason) => void;
}

export const createTuiInputHandler = (deps: InputHandlerDeps) =>
  (data: string): { consume: boolean } | undefined => {
    if (data.includes('\x03') || data.includes('\x04')) {
      deps.setShutdownReason('user_quit');
      deps.resolveExit();
      return { consume: true };
    }
    if (data.includes('\x0c')) {
      deps.editor.setText('');
      deps.requestRender();
      return { consume: true };
    }
    if (data.includes('\x1b') && !data.includes('\x1b[') && !data.includes('\r') && !data.includes('\n')) {
      if (!deps.turnTracker.isActive()) {
        deps.mainUI.enterPhase('idle');
        deps.mainUI.clearPreview();
        return { consume: true };
      }
      const interruptFile = path.join(deps.agentDir, 'interrupt');
      try {
        deps.fs.writeAtomicSync(interruptFile, '');
      } catch { /* silent: best-effort interrupt write */ }
      deps.turnTracker.requestInterrupt('esc');
      return { consume: true };
    }
    return undefined;
  };
