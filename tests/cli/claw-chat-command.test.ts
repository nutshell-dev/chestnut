/**
 * Phase 1247 Step C: claw chat command 回归测试。
 *
 * 验证 claw chat 实现不再直接调用 ensureWatchdog；
 * 监督职责已上提到 CLI action 边界。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLAW_CHAT_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/cli/commands/claw-chat.ts',
);

describe('claw chat command supervision refactor', () => {
  it('claw-chat.ts 源码不再直接 import ensureWatchdog', () => {
    const source = fs.readFileSync(CLAW_CHAT_SOURCE, 'utf-8');
    expect(source).not.toMatch(/ensureWatchdog/);
  });

  it('claw-chat.ts 仍导出 chatCommand', async () => {
    const mod = await import('../../src/cli/commands/claw-chat.js');
    expect(typeof mod.chatCommand).toBe('function');
  });
});
