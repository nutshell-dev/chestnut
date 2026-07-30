/**
 * Phase 1247 Step C: claw router 回归测试。
 *
 * 验证 claw router 不再直接调用 ensureWatchdog，且每个 verb 通过统一 policy helper 声明监督策略。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROUTER_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/cli/commands/claw-router.ts',
);

describe('claw router supervision refactor', () => {
  it('claw-router.ts 源码不再直接 import ensureWatchdog', () => {
    const source = fs.readFileSync(ROUTER_SOURCE, 'utf-8');
    expect(source).not.toMatch(/ensureWatchdog/);
  });

  it('claw-router.ts 使用 verbAction 包装 verb dispatch', () => {
    const source = fs.readFileSync(ROUTER_SOURCE, 'utf-8');
    expect(source).toMatch(/verbAction\(/);
  });

  it('claw-router.ts 仍导出 dispatchClawSubcommand', async () => {
    const mod = await import('../../src/cli/commands/claw-router.js');
    expect(typeof mod.dispatchClawSubcommand).toBe('function');
  });
});
