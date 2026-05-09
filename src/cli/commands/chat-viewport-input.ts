import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { TurnTracker } from './chat-viewport.js';

export type ShutdownReason = 'daemon_dead' | 'user_quit' | 'stream_end';

export interface InputHandlerDeps {
  fs: FileSystem;
  agentDir: string;
  turnTracker: TurnTracker;
  mainUI: MainTurnUIController;
  clearOutputLines: () => void;
  invalidateBodyCache: () => void;
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
      deps.clearOutputLines();
      deps.invalidateBodyCache();
      deps.mainUI.clearSuffix();
      return { consume: true };
    }
    if (data.includes('\x1b') && !data.includes('\x1b[') && !data.includes('\r') && !data.includes('\n')) {
      if (!deps.turnTracker.isActive()) {
        deps.mainUI.stopSpinner();
        deps.mainUI.clearSuffix();
        return { consume: true };
      }
      const interruptFile = path.join(deps.agentDir, 'interrupt');
      try {
        deps.fs.writeAtomicSync(interruptFile, '');
      } catch { /* best-effort */ }
      deps.turnTracker.requestInterrupt('esc');
      return { consume: true };
    }
    return undefined;
  };
