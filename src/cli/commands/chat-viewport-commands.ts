import * as path from 'path';
import { STREAM_FILE } from '../../foundation/stream/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { type ClawTrack, makeClawTrack } from './chat-viewport-claw-line.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { MainTurnUIController } from './main-turn-ui.js';
import type { ClawManager } from './chat-viewport-claw-manager.js';

export type ThinkingMode = 'compact' | 'full' | 'off';

export interface ViewportCommand {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string[]) => void | Promise<void>;
}

export interface CommandsDeps {
  isMotion: boolean;
  clawsDir: string;
  clawTrackMap: Map<string, ClawTrack>;
  fs: FileSystem;
  appendOutput: (color: string, text: string, wrap?: boolean, hangIndent?: string) => void;
  invalidateBodyCache: () => void;
  clearOutputLines: () => void;
  mainUI: MainTurnUIController;
  clawManager: ClawManager;
  updateClawPanel: (clawTrackMap: Map<string, ClawTrack>) => void;
  getThinkingMode: () => ThinkingMode;
  setThinkingMode: (m: ThinkingMode) => void;
  getRegistry: () => Map<string, ViewportCommand>;
}

export const createViewportCommands = (deps: CommandsDeps): ViewportCommand[] => {
  const cmds: ViewportCommand[] = [];

  cmds.push({
    name: 'think',
    description: '切换思考内容显示模式',
    usage: '/think [off|compact|full]',
    execute: (args) => {
      const arg = args[0] as ThinkingMode | undefined;
      let mode = deps.getThinkingMode();
      if (!arg) {
        mode = mode === 'off' ? 'full' : 'off';
      } else if (arg === 'off' || arg === 'compact' || arg === 'full') {
        mode = arg;
      } else {
        deps.appendOutput('\x1b[31m', `[think] 无效模式 "${arg}"，可选：off / compact / full`);
        return;
      }
      deps.setThinkingMode(mode);
      deps.appendOutput('\x1b[2m', `[thinking: ${mode}]`);
    },
  });

  cmds.push({
    name: 'attach',
    description: '将 claw 加入监视面板（仅 motion）',
    usage: '/attach <clawId>',
    execute: (args) => {
      if (!deps.isMotion) {
        deps.appendOutput('\x1b[31m', '[attach] 仅 motion chat 支持 /attach');
        return;
      }
      const clawId = args[0];
      if (!clawId) {
        deps.appendOutput('\x1b[31m', '[attach] 用法：/attach <clawId>');
        return;
      }
      const clawDir = path.join(deps.clawsDir, clawId);
      if (!deps.fs.existsSync(clawDir)) {
        deps.appendOutput('\x1b[31m', `[attach] claw "${clawId}" 不存在`);
      } else if (deps.clawTrackMap.has(clawId)) {
        deps.appendOutput('\x1b[2m', `[attach] ${clawId} 已在面板中`);
      } else {
        const t = makeClawTrack();
        t.referenceMs = Date.now();
        deps.clawTrackMap.set(clawId, t);
        deps.clawManager.attachClawWatcher(makeClawId(clawId), path.join(clawDir, STREAM_FILE));
        deps.updateClawPanel(deps.clawTrackMap);
        deps.appendOutput('\x1b[2m', `[attach] ${clawId} 已加入面板`);
      }
    },
  });

  cmds.push({
    name: 'detach',
    description: '从监视面板移除 claw（仅 motion）',
    usage: '/detach <clawId>  或  /detach --all',
    execute: async (args) => {
      const arg = args[0];
      if (!arg) {
        deps.appendOutput('', '用法：/detach <claw-id>  或  /detach --all');
        return;
      }
      if (arg === '--all') {
        await deps.clawManager.detachAllWatchers();
        deps.clawTrackMap.clear();
        deps.updateClawPanel(deps.clawTrackMap);
        deps.appendOutput('\x1b[2m', '[detach] 已清空所有 claw');
      } else {
        await deps.clawManager.detachWatcher(makeClawId(arg));
        deps.clawTrackMap.delete(arg);
        deps.updateClawPanel(deps.clawTrackMap);
        deps.appendOutput('\x1b[2m', `[detach] ${arg} 已从面板移除`);
      }
    },
  });

  cmds.push({
    name: 'clear',
    description: '清空输出区域',
    execute: () => {
      deps.clearOutputLines();
      deps.invalidateBodyCache();
      deps.mainUI.clearPreview();
    },
  });

  cmds.push({
    name: 'help',
    description: '显示可用命令列表',
    execute: () => {
      const lines = ['可用命令：'];
      for (const cmd of deps.getRegistry().values()) {
        lines.push(`  ${cmd.usage ?? '/' + cmd.name}  — ${cmd.description}`);
      }
      lines.push('快捷键：ESC 中断当前 turn  /  Ctrl+C 或 Ctrl+D 退出  /  Ctrl+L 清屏');
      deps.appendOutput('\x1b[2m', lines.join('\n'), true);
    },
  });

  return cmds;
};
