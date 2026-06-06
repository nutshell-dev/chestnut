import * as path from 'path';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { type ClawTrack, makeClawTrack } from './chat-viewport-claw-line.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { ClawManager } from './chat-viewport-claw-manager.js';

export type ThinkingMode = 'compact' | 'full' | 'off';

export interface ViewportCommand {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string[]) => void | Promise<void>;
}

/**
 * phase 31 P2.4: CommandsDeps 按 role 拆 ISP align。
 */

export interface CommandsClawDeps {
  isMotion: boolean;
  clawsDir: string;
  clawTrackMap: Map<string, ClawTrack>;
  fs: FileSystem;
  clawManager: ClawManager;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
}

export interface CommandsDisplayDeps {
  appendOutput: (color: string, text: string, wrap?: boolean, hangIndent?: string) => void;
  invalidateBodyCache: () => void;
  clearOutputLines: () => void;
  mainUI: MainTurnUIController;
}

export interface CommandsConfigDeps {
  getThinkingMode: () => ThinkingMode;
  setThinkingMode: (m: ThinkingMode) => void;
  getRegistry: () => Map<string, ViewportCommand>;
}

export type CommandsDeps = CommandsClawDeps & CommandsDisplayDeps & CommandsConfigDeps;

export const createViewportCommands = (deps: CommandsDeps): ViewportCommand[] => {
  const cmds: ViewportCommand[] = [];

  cmds.push({
    name: 'think',
    description: 'toggle thinking display mode',
    usage: '/think [off|compact|full]',
    execute: (args) => {
      const arg = args[0] as ThinkingMode | undefined;
      let mode = deps.getThinkingMode();
      if (!arg) {
        mode = mode === 'off' ? 'full' : 'off';
      } else if (arg === 'off' || arg === 'compact' || arg === 'full') {
        mode = arg;
      } else {
        deps.appendOutput('\x1b[31m', `[think] invalid mode "${arg}", options: off / compact / full`);
        return;
      }
      deps.setThinkingMode(mode);
      deps.appendOutput('\x1b[2m', `[thinking: ${mode}]`);
    },
  });

  cmds.push({
    name: 'attach',
    description: 'attach a claw to the watch panel (motion only)',
    usage: '/attach <clawId>',
    execute: (args) => {
      if (!deps.isMotion) {
        deps.appendOutput('\x1b[31m', '[attach] /attach is only supported in motion chat');
        return;
      }
      const clawId = args[0];
      if (!clawId) {
        deps.appendOutput('\x1b[31m', '[attach] usage: /attach <clawId>');
        return;
      }
      const clawDir = path.join(deps.clawsDir, clawId);
      if (!deps.fs.existsSync(clawDir)) {
        deps.appendOutput('\x1b[31m', `[attach] claw "${clawId}" not found`);
      } else if (deps.clawTrackMap.has(clawId)) {
        deps.appendOutput('\x1b[2m', `[attach] ${clawId} already attached`);
      } else {
        const t = makeClawTrack();
        t.referenceMs = Date.now();
        deps.clawTrackMap.set(clawId, t);
        deps.clawManager.attachClawWatcher(clawId, path.join(clawDir, STREAM_FILE));
        deps.updateClawPanel(deps.clawTrackMap);
        deps.appendOutput('\x1b[2m', `[attach] ${clawId} attached`);
      }
    },
  });

  cmds.push({
    name: 'detach',
    description: 'detach a claw from the watch panel (motion only)',
    usage: '/detach <clawId>  or  /detach --all',
    execute: async (args) => {
      const arg = args[0];
      if (!arg) {
        deps.appendOutput('', 'usage: /detach <claw-id>  or  /detach --all');
        return;
      }
      if (arg === '--all') {
        await deps.clawManager.detachAllWatchers();
        deps.clawTrackMap.clear();
        deps.updateClawPanel(deps.clawTrackMap);
        deps.appendOutput('\x1b[2m', '[detach] all claws detached');
      } else {
        await deps.clawManager.detachWatcher(arg);
        deps.clawTrackMap.delete(arg);
        deps.updateClawPanel(deps.clawTrackMap);
        deps.appendOutput('\x1b[2m', `[detach] ${arg} detached`);
      }
    },
  });

  cmds.push({
    name: 'clear',
    description: 'clear the output area',
    execute: () => {
      deps.clearOutputLines();
      deps.invalidateBodyCache();
      deps.mainUI.clearPreview();
    },
  });

  cmds.push({
    name: 'help',
    description: 'show available commands',
    execute: () => {
      const lines = ['Available commands:'];
      for (const cmd of deps.getRegistry().values()) {
        lines.push(`  ${cmd.usage ?? '/' + cmd.name}  — ${cmd.description}`);
      }
      lines.push('Shortcuts: ESC interrupt current turn  /  Ctrl+C or Ctrl+D quit  /  Ctrl+L clear');
      deps.appendOutput('\x1b[2m', lines.join('\n'), true);
    },
  });

  return cmds;
};
