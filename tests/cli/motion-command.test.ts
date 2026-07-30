/**
 * Phase 1247 Step C: motion command 回归测试。
 *
 * 验证 motion chat 实现不再直接调用 ensureWatchdog；
 * 监督职责已上提到 CLI action 边界。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const MOTION_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/cli/commands/motion.ts',
);

describe('motion command supervision refactor', () => {
  it('motion.ts 源码不再直接 import ensureWatchdog', () => {
    const source = fs.readFileSync(MOTION_SOURCE, 'utf-8');
    expect(source).not.toMatch(/ensureWatchdog/);
  });

  it('motion.ts 仍导出 chatCommand', async () => {
    const mod = await import('../../src/cli/commands/motion.js');
    expect(typeof mod.chatCommand).toBe('function');
  });
});
