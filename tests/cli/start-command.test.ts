/**
 * Phase 1247 Step C / phase 1280 Step B: start command 监督边界回归测试。
 *
 * 验证：
 * - start.ts 不直接依赖 Watchdog（无 watchdog import、无 ensureWatchdog 引用）；
 *   监督能力由 CLI 监督边界以 ensureSupervision capability 注入。
 * - startCommand 的 ensureSupervision 为显式必传（禁止默认 no-op 掩盖漏接线）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const START_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/cli/commands/start.ts',
);

describe('start command supervision boundary', () => {
  it('start.ts 不 import Watchdog daemon 也不引用 ensureWatchdog 监督原语', () => {
    const source = fs.readFileSync(START_SOURCE, 'utf-8');
    // 边界针对 Watchdog daemon 模块目录（../watchdog/）与监督原语 ensureWatchdog。
    // phase 1890 Step J：同层迁移编排特许随删除回收。
    expect(source).not.toMatch(/from\s+['"][^'"]*\.\.\/watchdog\//);
    expect(source).not.toMatch(/\bensureWatchdog\b/);
  });

  it('startCommand 依赖显式必传的 ensureSupervision capability', () => {
    const source = fs.readFileSync(START_SOURCE, 'utf-8');
    // runtime 中 ensureSupervision 为必需字段（非可选 `?`、无默认值）
    expect(source).toMatch(/ensureSupervision:\s*EnsureSupervision/);
  });

  it('start.ts 仍导出 startCommand', async () => {
    const mod = await import('../../src/cli/commands/start.js');
    expect(typeof mod.startCommand).toBe('function');
  });
});
