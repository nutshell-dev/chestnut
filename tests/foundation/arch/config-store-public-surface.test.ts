/**
 * Phase 1297 Step C/D: ConfigStore public surface ratchet。
 *
 * 冻结两条 module invariant：
 * 1. 唯一 caller 经 barrel：src 内对 ConfigStore 的 import 只有
 *    assembly/config/config-load.ts 一条边、且必须指向 index barrel；
 * 2. 最小 barrel：无 export *、导出集合精确匹配 phase 1297 计划表面。
 *
 * 物理归属/依赖方向/零业务符号 invariant 归 config-store-boundary.test.ts。
 * scanner 均带反向 fixture 自证（不是恒真断言）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROJECT_ROOT,
  SRC_ROOT,
  CONFIG_STORE_DIR,
  CONFIG_STORE_BARREL,
  stripExtension,
  collectRelativeImportEdges,
  isInsideConfigStore,
} from './config-store-boundary-helpers.js';

/** 解析路径是否指向 ConfigStore barrel（而非 deep-import）。 */
function isConfigStoreBarrel(resolved: string): boolean {
  return stripExtension(resolved) === CONFIG_STORE_BARREL;
}

/** 解析 barrel 文本中 `export { ... } from` 的导出名集合（含 type 导出）。 */
function parseBarrelExports(text: string): string[] {
  const names: string[] = [];
  const re = /export\s*\{([^}]*)\}\s*from/g;
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (name) names.push(name);
    }
  }
  return names.sort();
}

const EXPECTED_BARREL_SURFACE = [
  'ConfigStoreError',
  'configExists',
  'isConfigStoreError',
  'loadYamlConfig',
  'patchYamlConfig',
  'writeYamlConfig',
];

describe('phase 1297: ConfigStore 唯一 caller 经 barrel', () => {
  it('src 内对 ConfigStore 的 import 只有 assembly/config/config-load.ts 且指向 barrel', () => {
    // 排除 ConfigStore 模块内部边，只统计外部 caller。
    const edges = collectRelativeImportEdges(SRC_ROOT).filter((e) =>
      isInsideConfigStore(e.resolved) && !isInsideConfigStore(path.resolve(PROJECT_ROOT, e.file))
    );
    const deepImports = edges.filter((e) => !isConfigStoreBarrel(e.resolved));
    expect(deepImports).toEqual([]);
    expect([...new Set(edges.map((e) => e.file))].sort()).toEqual([
      path.join('src', 'assembly', 'config', 'config-load.ts'),
    ]);
  });

  it('反向 fixture：deep-import store.js 必须被判定违规', () => {
    const deep = path.join(CONFIG_STORE_DIR, 'store.js');
    expect(isInsideConfigStore(deep)).toBe(true);
    expect(isConfigStoreBarrel(deep)).toBe(false);
    expect(isConfigStoreBarrel(path.join(CONFIG_STORE_DIR, 'index.js'))).toBe(true);
  });
});

describe('phase 1297: ConfigStore 最小 barrel 表面', () => {
  it('barrel 无 export * 且导出集合精确匹配计划表面', () => {
    const text = fs.readFileSync(path.join(CONFIG_STORE_DIR, 'index.ts'), 'utf8');
    expect(text).not.toMatch(/export\s*\*/);
    expect(parseBarrelExports(text)).toEqual(EXPECTED_BARREL_SURFACE);
  });

  it('反向 fixture：export * 与额外符号必须被检出', () => {
    expect('export * from \'./store.js\';').toMatch(/export\s*\*/);
    const withExtra = parseBarrelExports(
      'export { loadYamlConfig, extraImpl } from \'./store.js\';\n',
    );
    expect(withExtra).not.toEqual(EXPECTED_BARREL_SURFACE);
  });
});
