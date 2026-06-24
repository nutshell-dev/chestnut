import * as path from 'path';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { ClawTopology } from '../../core/claw-topology/index.js';
import { makeClawId } from '../../foundation/claw-identity/index.js';
import { type ClawTrack, makeClawTrack } from './chat-viewport-claw-line.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { ClawManager } from './chat-viewport-claw-manager.js';
import type { CommandResult } from './viewport-command-result.js';
import type { RenderDescriptor } from './viewport-render-descriptor.js';

export type ThinkingMode = 'compact' | 'full' | 'off';

export interface ViewportCommand {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string[]) => CommandResult | Promise<CommandResult>;
}

/**
 * phase 31 P2.4: CommandsDeps 按 role 拆 ISP align。
 * phase 443 Step B: Display + claw-panel side-effects 收入 RenderDescriptor、
 * CommandsDeps 仅保留命令实施期需读的 state（mainUI / topology / clawManager / config）。
 */

export interface CommandsClawDeps {
  isMotion: boolean;
  clawTopology: ClawTopology;
  clawTrackMap: Map<string, ClawTrack>;
  fs: FileSystem;
  clawManager: ClawManager;
}

export interface CommandsConfigDeps {
  mainUI: MainTurnUIController;
  getThinkingMode: () => ThinkingMode;
  setThinkingMode: (m: ThinkingMode) => void;
  getRegistry: () => Map<string, ViewportCommand>;
}

export type CommandsDeps = CommandsClawDeps & CommandsConfigDeps;

const textLine = (color: string, text: string, wrap?: boolean): RenderDescriptor =>
  ({ kind: 'text-line', color, text, ...(wrap ? { wrap } : {}) });

export const createViewportCommands = (deps: CommandsDeps): ViewportCommand[] => {
  const cmds: ViewportCommand[] = [];

  cmds.push({
    name: 'think',
    description: 'toggle thinking display mode',
    usage: '/think [off|compact|full]',
    execute: (args): CommandResult => {
      const arg = args[0] as ThinkingMode | undefined;
      let mode = deps.getThinkingMode();
      if (!arg) {
        mode = mode === 'off' ? 'full' : 'off';
      } else if (arg === 'off' || arg === 'compact' || arg === 'full') {
        mode = arg;
      } else {
        return { descriptors: [textLine('\x1b[31m', `[think] invalid mode "${arg}", options: off / compact / full`)] };
      }
      deps.setThinkingMode(mode);
      return { descriptors: [textLine('\x1b[2m', `[thinking: ${mode}]`)] };
    },
  });

  cmds.push({
    name: 'attach',
    description: 'attach a claw to the watch panel (motion only)',
    usage: '/attach <clawId>',
    execute: (args): CommandResult => {
      if (!deps.isMotion) {
        return { descriptors: [textLine('\x1b[31m', '[attach] /attach is only supported in motion chat')] };
      }
      const clawId = args[0];
      if (!clawId) {
        return { descriptors: [textLine('\x1b[31m', '[attach] usage: /attach <clawId>')] };
      }
      const location = deps.clawTopology.resolve(makeClawId(clawId));
      if (location.kind !== 'local') {
        return { descriptors: [textLine('\x1b[31m', `[attach] claw "${clawId}" remote location not supported`)] };
      }
      const clawDir = location.clawDir;
      if (!deps.fs.existsSync(clawDir)) {
        return { descriptors: [textLine('\x1b[31m', `[attach] claw "${clawId}" not found`)] };
      }
      if (deps.clawTrackMap.has(clawId)) {
        return { descriptors: [textLine('\x1b[2m', `[attach] ${clawId} already attached`)] };
      }
      const t = makeClawTrack();
      t.referenceMs = Date.now();
      deps.clawTrackMap.set(clawId, t);
      deps.clawManager.attachClawWatcher(clawId, path.join(clawDir, STREAM_FILE));
      return {
        descriptors: [
          { kind: 'claw-panel-update' },
          textLine('\x1b[2m', `[attach] ${clawId} attached`),
        ],
      };
    },
  });

  cmds.push({
    name: 'detach',
    description: 'detach a claw from the watch panel (motion only)',
    usage: '/detach <clawId>  or  /detach --all',
    execute: async (args): Promise<CommandResult> => {
      const arg = args[0];
      if (!arg) {
        return { descriptors: [textLine('', 'usage: /detach <claw-id>  or  /detach --all')] };
      }
      if (arg === '--all') {
        await deps.clawManager.detachAllWatchers();
        deps.clawTrackMap.clear();
        return {
          descriptors: [
            { kind: 'claw-panel-update' },
            textLine('\x1b[2m', '[detach] all claws detached'),
          ],
        };
      }
      await deps.clawManager.detachWatcher(arg);
      deps.clawTrackMap.delete(arg);
      return {
        descriptors: [
          { kind: 'claw-panel-update' },
          textLine('\x1b[2m', `[detach] ${arg} detached`),
        ],
      };
    },
  });

  cmds.push({
    name: 'clear',
    description: 'clear the output area',
    execute: (): CommandResult => {
      deps.mainUI.clearPreview();
      return {
        descriptors: [
          { kind: 'clear-lines' },
          { kind: 'invalidate-cache' },
        ],
      };
    },
  });

  cmds.push({
    name: 'help',
    description: 'show available commands',
    execute: (): CommandResult => {
      const lines = ['Available commands:'];
      for (const cmd of deps.getRegistry().values()) {
        lines.push(`  ${cmd.usage ?? '/' + cmd.name}  — ${cmd.description}`);
      }
      lines.push('Shortcuts: ESC interrupt current turn  /  Ctrl+C or Ctrl+D quit  /  Ctrl+L clear');
      return { descriptors: [textLine('\x1b[2m', lines.join('\n'), true)] };
    },
  });

  return cmds;
};
