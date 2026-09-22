import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 1894 Step D：lint:arch 路由经守卫脚本不变式。
 *
 * 背景：dependency-cruiser 对 supportedTranspilers 区间外的 typescript 版本
 * 静默产出 0 modules 仍 exit 0（phase 1894 §4.4 实证），架构门禁空跑假绿。
 * 守卫 scripts/lint-arch.mjs 把该形态变为显式失败（graph nodes > 50 下限断言）。
 *
 * 本测试锁「lint:arch 必须路由经守卫脚本」，防未来被改回裸 depcruise
 * 而无人察觉——同一静默形态上移一层。纯文件读、无 vi.mock，归 fast project。
 */
describe('lint-arch-guard-invariant (phase 1894 Step D)', () => {
  it('package.json lint:arch routes through the guard script', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['lint:arch']).toBe('node scripts/lint-arch.mjs');
  });

  it('guard script keeps the depcruise invocation and the graph-nodes floor', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const source = fs.readFileSync(path.join(repoRoot, 'scripts/lint-arch.mjs'), 'utf-8');
    // 守卫必须仍调用现行 depcruise 配置与扫描面
    expect(source).toContain("'.config/dependency-cruiser.cjs'");
    expect(source).toContain("'src'");
    // 下限断言存在：graph nodes 未超下限时必须非零退出（fail loud）
    expect(source).toContain('MIN_GRAPH_NODES');
    // 汇总行解析存在：格式漂移时显式失败，不静默放行
    expect(source).toContain('dependencies cruised');
  });
});
