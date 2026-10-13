import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { TurnTracker, ViewportHistoryControls } from './chat-viewport-types.js';
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
  /** phase 1937 Step C: 历史浏览滚动控制（可选；缺省时历史键不拦截）。 */
  history?: ViewportHistoryControls;
}

type ScrollAction = 'pageUp' | 'pageDown' | 'up' | 'down' | 'home' | 'end';

/**
 * 历史浏览按键映射（phase 1937 Step C）。
 * - PageUp/PageDown、Shift+Up/Shift+Down 始终作用于历史窗口；
 * - 裸 Up/Down、Home/End 仅在浏览历史时拦截（follow-tail 时透传给编辑器，
 *   不改变既有编辑/输入历史行为）。
 */
const SCROLL_KEY_SEQUENCES: ReadonlyArray<{ seq: string; action: ScrollAction; browsingOnly: boolean }> = [
  { seq: '\x1b[5~', action: 'pageUp', browsingOnly: false },
  { seq: '\x1b[6~', action: 'pageDown', browsingOnly: false },
  { seq: '\x1b[1;2A', action: 'up', browsingOnly: false },     // Shift+Up
  { seq: '\x1b[1;2B', action: 'down', browsingOnly: false },   // Shift+Down
  { seq: '\x1b[A', action: 'up', browsingOnly: true },
  { seq: '\x1b[B', action: 'down', browsingOnly: true },
  { seq: '\x1b[H', action: 'home', browsingOnly: true },
  { seq: '\x1bOH', action: 'home', browsingOnly: true },
  { seq: '\x1b[1~', action: 'home', browsingOnly: true },
  { seq: '\x1b[F', action: 'end', browsingOnly: true },
  { seq: '\x1bOF', action: 'end', browsingOnly: true },
  { seq: '\x1b[4~', action: 'end', browsingOnly: true },
];

/** 整个 chunk 必须是已知滚动键序列的一次或多次重复，否则返回 undefined（透传）。 */
export function parseScrollKeys(data: string): Array<{ action: ScrollAction; browsingOnly: boolean }> | undefined {
  const actions: Array<{ action: ScrollAction; browsingOnly: boolean }> = [];
  let i = 0;
  while (i < data.length) {
    const hit = SCROLL_KEY_SEQUENCES.find(k => data.startsWith(k.seq, i));
    if (!hit) return undefined;
    actions.push({ action: hit.action, browsingOnly: hit.browsingOnly });
    i += hit.seq.length;
  }
  return actions.length > 0 ? actions : undefined;
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

    // phase 1937 Step C: 历史浏览滚动（PageUp/PageDown 与 Shift+方向始终接管；
    // 裸 Up/Down、Home/End 仅在浏览历史时接管，否则透传给编辑器）。
    if (deps.history) {
      const actions = parseScrollKeys(data);
      if (actions && actions.every(a => !a.browsingOnly || deps.history!.isBrowsing())) {
        for (const a of actions) {
          switch (a.action) {
            case 'pageUp': deps.history.pageUp(); break;
            case 'pageDown': deps.history.pageDown(); break;
            case 'up': deps.history.scrollUp(1); break;
            case 'down': deps.history.scrollDown(1); break;
            case 'home': deps.history.toOldest(); break;
            case 'end': deps.history.toBottom(); break;
          }
        }
        return { consume: true };
      }
    }
    return undefined;
  };
