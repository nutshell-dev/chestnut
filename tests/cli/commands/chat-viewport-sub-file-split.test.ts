import { describe, it, expect } from 'vitest';
import * as ChatViewportMain from '../../../src/cli/commands/chat-viewport.js';
import * as fs from 'node:fs/promises';

const SUB_FILES = [
  'chat-viewport-claw-line.ts',
  'chat-viewport-claw-manager.ts',
  'chat-viewport-claw-panel.ts',
  'chat-viewport-commands.ts',
  'chat-viewport-display.ts',
  'chat-viewport-event-handler.ts',
  'chat-viewport-init.ts',
  'chat-viewport-input.ts',
  'chat-viewport-observability.ts',
  'chat-viewport-task-events.ts',
  'chat-viewport-task-status-bar.ts',
  'chat-viewport-turn-tracker.ts',
  'chat-viewport-types.ts',
  'chat-viewport-utils.ts',
  'chat-viewport-watcher.ts',
];

describe('phase 1209 + 1228 chat-viewport sub-file cluster DAG', () => {
  // 反向 1：公开 API signature 不动 (原断言保留)
  it('public exports: runChatViewport + ChatViewportOptions + TurnTracker unchanged', () => {
    expect(typeof ChatViewportMain.runChatViewport).toBe('function');
    type Assert1 = ChatViewportMain.ChatViewportOptions extends { agentDir: string } ? true : never;
    type Assert2 = ChatViewportMain.TurnTracker extends { begin(): void } ? true : never;
    const _a1: Assert1 = true;
    const _a2: Assert2 = true;
    expect(_a1).toBe(true);
    expect(_a2).toBe(true);
  });

  // 反向 2 (重写 by phase 1228): cluster DAG / 无 cycle (ML#5 严格判断)
  it('14 sub-file cluster forms a DAG (no cycle / ML#5 严格判断)', async () => {
    const importMap = new Map<string, Set<string>>();
    for (const file of SUB_FILES) {
      const content = await fs.readFile(`src/cli/commands/${file}`, 'utf-8');
      const imports = new Set<string>();
      for (const other of SUB_FILES) {
        if (other === file) continue;
        const otherBase = other.replace('.ts', '');
        if (new RegExp(`from ['"]\\./${otherBase}`).test(content)) {
          imports.add(other);
        }
      }
      importMap.set(file, imports);
    }

    // DFS detect back edge for cycle
    function hasCycle(): boolean {
      const WHITE = 0, GRAY = 1, BLACK = 2;
      const color = new Map<string, number>();
      for (const f of SUB_FILES) color.set(f, WHITE);

      function dfs(node: string): boolean {
        color.set(node, GRAY);
        const deps = importMap.get(node) ?? new Set();
        for (const dep of deps) {
          if (color.get(dep) === GRAY) return true; // back edge = cycle
          if (color.get(dep) === WHITE && dfs(dep)) return true;
        }
        color.set(node, BLACK);
        return false;
      }

      for (const f of SUB_FILES) {
        if (color.get(f) === WHITE && dfs(f)) return true;
      }
      return false;
    }

    expect(hasCycle()).toBe(false);
  });

  // 反向 3 (扩 scope by phase 1228): thin orchestration imports cluster sub-files
  it('chat-viewport.ts (thin orch) imports cluster sub-files', async () => {
    const main = await fs.readFile('src/cli/commands/chat-viewport.ts', 'utf-8');
    let importedCount = 0;
    for (const sub of SUB_FILES) {
      const subBase = sub.replace('.ts', '');
      if (new RegExp(`from ['"]\\./${subBase}`).test(main)) {
        importedCount++;
      }
    }
    // thin orch 应 import 至少 phase 1209 原 5 sub-file 中的若干个
    expect(importedCount).toBeGreaterThanOrEqual(5);
  });
});
