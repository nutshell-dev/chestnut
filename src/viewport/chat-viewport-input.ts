import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { TurnTracker } from './chat-viewport-types.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

export type ShutdownReason = 'daemon_dead' | 'user_quit' | 'stream_end';

interface EditorHandle {
  getText(): string;
  setText(text: string): void;
}

export interface InputHandlerDeps {
  fs: FileSystem;
  audit: AuditLog;
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
    // Ctrl+D: 清空输入
    if (data.includes('\x04')) {
      deps.editor.setText('');
      deps.requestRender();
      return { consume: true };
    }
    // Ctrl+C: 有内容清空，无内容退出
    if (data.includes('\x03')) {
      if (deps.editor.getText().trim().length > 0) {
        deps.editor.setText('');
        deps.requestRender();
      } else {
        deps.setShutdownReason('user_quit');
        deps.resolveExit();
      }
      return { consume: true };
    }
    if (data.includes('\x0c')) {
      deps.editor.setText('');
      deps.requestRender();
      return { consume: true };
    }
    // StdinBuffer may prefix high UTF-8 bytes or Option/meta keys with ESC.
    // Only the exact single-byte ESC sequence represents the user's interrupt
    // intent; matching any string containing ESC causes false interrupts.
    if (data === '\x1b') {
      if (!deps.turnTracker.isActive()) {
        deps.mainUI.enterPhase('idle');
        deps.mainUI.clearPreview();
        return { consume: true };
      }
      const interruptFile = path.join(deps.agentDir, 'interrupt');
      try {
        deps.fs.writeAtomicSync(interruptFile, '');
      } catch (err) {
        try {
          deps.audit.write(
            VIEWPORT_AUDIT_EVENTS.INTERRUPT_PERSIST_FAILED,
            `reason=${formatErr(err)}`,
            'local_state=active',
          );
        } catch { /* audit self-failure tolerated */ }
        return { consume: true };
      }
      deps.turnTracker.requestInterrupt('esc');
      return { consume: true };
    }
    return undefined;
  };
