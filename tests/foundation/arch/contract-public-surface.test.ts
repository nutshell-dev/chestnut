/**
 * Phase 1792 Step B (CT-D1): ContractSystem public surface 边界专测。
 *
 * 与 phase 1349 ratchet（contract-public-surface-ratchet.test.ts，禁导出清单）互补：
 * 本测试锚定**允许的最小入口**（manager 生命周期 + canonical ID + query）必须存在，
 * 且禁导出的 owner-internal verification/lifecycle 类型不得以别名形态回流
 * （`export type { X as Y }` 兼容别名属 Step A 明令禁止）。
 *
 * notification protocol（ContractNotification/ContractNotificationSink）为
 * phase 1260/1262 ratified 公共 protocol（contract-notification-boundary.test.ts 锁定），
 * 不在禁列。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const barrelPath = path.join(process.cwd(), 'src/core/contract', 'index.ts');

const REQUIRED_ENTRIES = [
  "export { ContractSystem, createContractSystem } from './manager.js';",
  'type ContractId',
  'makeContractId',
  // phase 1846 Step B: read-only terminal fact query minimal entry
  'readContractTerminalFact',
  'ContractTerminalFact',
] as const;

const FORBIDDEN_EXPORTS = [
  'ContractExecutionFailure',
  'LifecycleCommitOutcome',
] as const;

describe('phase 1792: ContractSystem public surface（CT-D1）', () => {
  const barrel = fs.readFileSync(barrelPath, 'utf8');

  it('允许入口：manager 生命周期 + canonical ID 契约存在', () => {
    for (const entry of REQUIRED_ENTRIES) {
      expect(barrel).toContain(entry);
    }
  });

  it('禁导出：owner-internal verification/lifecycle 类型不经 barrel 暴露（含别名形态）', () => {
    for (const symbol of FORBIDDEN_EXPORTS) {
      expect(barrel).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      // 别名回流（export type { X as Y }）同样拒绝
      expect(barrel).not.toMatch(new RegExp(`\\bas\\s+${symbol}\\b`));
    }
  });
});
