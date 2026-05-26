import { describe, it, expect } from 'vitest';
// @ts-ignore — CJS config loaded in ESM test context
import config from '../../../.dependency-cruiser.cjs';

/**
 * dependency-cruiser config: phase 1301 tsPreCompilationDeps + no-orphans
 *
 * 反向：防 dep-cruise config silent 改 tsPreCompilationDeps 或 no-orphans rule
 * (mirror phase 1298 vitest config sync test 模式扩到 orphan detection 维度)
 *
 * 若 future 升 no-orphans severity warn → error → 必同时更新本 test + design row
 */
describe('dependency-cruiser config: phase 1301 tsPreCompilationDeps + no-orphans', () => {
  it('tsPreCompilationDeps enabled for TS type-only import tracking', () => {
    expect(config.options).toBeDefined();
    expect(config.options.tsPreCompilationDeps).toBe(true);
  });

  it('no-orphans rule present at warn severity with allowlist', () => {
    const rule = config.forbidden.find(
      (r: { name: string }) => r.name === 'no-orphans',
    );
    expect(rule).toBeDefined();
    expect(rule.severity).toBe('warn');
    expect(rule.from.orphan).toBe(true);
    expect(rule.from.pathNot).toContain('\\.d\\.ts$');
    expect(rule.from.pathNot).toContain('^src/index\\.ts$');
    expect(rule.from.pathNot).toContain('\\.dependency-cruiser\\.cjs$');
  });
});
