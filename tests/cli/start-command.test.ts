/**
 * Phase 1247 Step C: start command 回归测试。
 *
 * 验证 start command 实现不再直接调用 ensureWatchdog；
 * 监督职责已上提到 CLI action 边界。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const START_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/cli/commands/start.ts',
);

describe('start command supervision refactor', () => {
  it('start.ts 源码不再 import ensureWatchdog', () => {
    const source = fs.readFileSync(START_SOURCE, 'utf-8');
    expect(source).not.toMatch(/ensureWatchdog/);
  });

  it('start.ts 仍导出 startCommand', async () => {
    const mod = await import('../../src/cli/commands/start.js');
    expect(typeof mod.startCommand).toBe('function');
  });
});
