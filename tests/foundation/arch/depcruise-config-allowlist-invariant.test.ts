import { describe, it, expect } from 'vitest';
// @ts-ignore — CJS config loaded in ESM test context
import config from '../../../.config/dependency-cruiser.cjs';

/**
 * dependency-cruiser config allowlist sync with design row (phase 1298)
 *
 * 反向：防 dep-cruise config silent 改 allowlist 漏 sync design row
 * (mirror phase 1283 vitest grep test 模式扩到 config sync 维度)
 *
 * 若 future 加新 bootstrap site / 新 design intent file → 必同时更新:
 *   1. 本 test allowlist 期望
 *   2. design row §3.1 (l1_filesystem.md「Bootstrap 与 design intent allowlist」) 列表
 *   3. .dependency-cruiser.cjs 配置
 */
describe('dependency-cruiser config: allowlist sync (phase 1298 / phase 572 extended)', () => {
  it('fs-only-via-foundation-filesystem allowlist matches 4 design intent file', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'fs-only-via-foundation-filesystem',
    );
    expect(rule).toBeDefined();
    expect(rule.severity).toBe('error');
    expect(rule.from.pathNot).toEqual([
      '^src/foundation/fs/',
      '^src/foundation/audit/writer\\.ts$',
      '^src/foundation/audit/reader\\.ts$',
      '^src/foundation/process-exec/spawn-detached\\.ts$',
    ]);
  });

  it('nodefilesystem-only-from-bootstrap allowlist matches 6 bootstrap site + fs impl', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'nodefilesystem-only-from-bootstrap',
    );
    expect(rule).toBeDefined();
    expect(rule.severity).toBe('error');
    expect(rule.from.pathNot).toEqual([
      '^src/assembly/assemble\\.ts$',
      '^src/assembly/core-infrastructure\\.ts$',
      '^src/cli/index\\.ts$',
      '^src/daemon-entry\\.ts$',
      '^src/daemon-handlers\\.ts$',
      '^src/watchdog-entry\\.ts$',
      '^src/foundation/fs/',
    ]);
  });

  // phase 572 扩: 加 3 sister rule (crypto/child_process/net) allowlist sync invariant
  // 同型 phase 455/490/491 立 (sister to fs-only / nodefilesystem-only pattern)

  it('crypto-only-from-foundation allowlist matches 2 owner module (node-utils/crypto + node-utils/id)', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'crypto-only-from-foundation',
    );
    expect(rule).toBeDefined();
    expect(rule.severity).toBe('error');
    expect(rule.from.pathNot).toEqual([
      '^src/foundation/node-utils/crypto\\.ts$',
      '^src/foundation/node-utils/id\\.ts$',
    ]);
  });

  it('child-process-only-from-foundation-process-exec allowlist matches foundation/process-exec/ dir', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'child-process-only-from-foundation-process-exec',
    );
    expect(rule).toBeDefined();
    expect(rule.severity).toBe('error');
    expect(rule.from.pathNot).toEqual([
      '^src/foundation/process-exec/',
    ]);
  });

  it('net-only-from-foundation-transport allowlist matches foundation/transport/ dir', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'net-only-from-foundation-transport',
    );
    expect(rule).toBeDefined();
    expect(rule.severity).toBe('error');
    expect(rule.from.pathNot).toEqual([
      '^src/foundation/transport/',
    ]);
  });
});
