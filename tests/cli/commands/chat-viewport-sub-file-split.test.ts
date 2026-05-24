import { describe, it, expect } from 'vitest';
import * as ChatViewportMain from '../../../src/cli/commands/chat-viewport.js';

describe('phase 1209 chat-viewport sub-file split', () => {
  // 反向 1：公开 API signature 不动
  it('public exports: runChatViewport + ChatViewportOptions + TurnTracker unchanged', () => {
    expect(typeof ChatViewportMain.runChatViewport).toBe('function');
    // type-level: ChatViewportOptions + TurnTracker still exported (tsc enforce)
    type Assert1 = ChatViewportMain.ChatViewportOptions extends { agentDir: string } ? true : never;
    type Assert2 = ChatViewportMain.TurnTracker extends { begin(): void } ? true : never;
    const _a1: Assert1 = true;
    const _a2: Assert2 = true;
    expect(_a1).toBe(true);
    expect(_a2).toBe(true);
  });

  // 反向 2：sub-file 0 cross-import each other
  it('5 sub-files have no cross-imports (ML#5 单向)', async () => {
    const fs = await import('node:fs/promises');
    const subFiles = [
      'chat-viewport-turn-tracker.ts',
      'chat-viewport-event-handler.ts',
      'chat-viewport-claw-panel.ts',
      'chat-viewport-display.ts',
      'chat-viewport-init.ts',
    ];
    for (const file of subFiles) {
      const content = await fs.readFile(`src/cli/commands/${file}`, 'utf-8');
      for (const other of subFiles) {
        if (other === file) continue;
        const otherBase = other.replace('.ts', '');
        expect(content).not.toMatch(new RegExp(`from ['"]\\./${otherBase}`));
      }
    }
  });

  // 反向 3：thin orchestration import all 5 sub-file
  it('chat-viewport.ts imports all 5 sub-files', async () => {
    const fs = await import('node:fs/promises');
    const main = await fs.readFile('src/cli/commands/chat-viewport.ts', 'utf-8');
    const expected = [
      'chat-viewport-turn-tracker',
      'chat-viewport-event-handler',
      'chat-viewport-claw-panel',
      'chat-viewport-display',
      'chat-viewport-init',
    ];
    for (const sub of expected) {
      expect(main).toMatch(new RegExp(`from ['"]\\./${sub}`));
    }
  });
});
