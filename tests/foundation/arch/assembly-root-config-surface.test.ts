/**
 * Phase 1300 Step B: Assembly RootConfig 稳定表面 ratchet。
 *
 * 冻结三条 invariant：
 * 1. Assembly barrel 的 RootConfig 相关新增集合精确为计划表面
 *    （createRootConfig/resolveLLMConfig/RootConfigReader/RootConfigAdmin/RootConfigDeps），
 *    且不出现 config-load 旧函数、path helper、generic ConfigStore、legacy migration 符号；
 * 2. root-config.ts 只组合同模块 owner 函数：不 import ConfigStore/FileSystem 实现，
 *    FileSystem 仅 type-only 依赖 barrel；
 * 3. factory 无模块级 mutable cache/singleton（M#4 无缓存）。
 *
 * scanner 均带反向 fixture 自证（不是恒真断言）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const ASSEMBLY_BARREL = path.join(PROJECT_ROOT, 'src', 'assembly', 'index.ts');
const ROOT_CONFIG_TS = path.join(PROJECT_ROOT, 'src', 'assembly', 'config', 'root-config.ts');

/** 解析 barrel 文本中 `export { ... } from` / `export type { ... } from` 的导出名集合。 */
function parseBarrelExports(text: string): string[] {
  const names: string[] = [];
  const re = /export\s*(?:type\s*)?\{([^}]*)\}\s*from/g;
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (name) names.push(name);
    }
  }
  return names;
}

/** barrel 导出中 RootConfig 相关（本 phase 新增候选）的子集。 */
function rootConfigSurface(exports: string[]): string[] {
  return exports.filter((n) => /^(createRootConfig(?:LegacyMigration)?|resolveLLMConfig|RootConfig\w*)$/.test(n)).sort();
}

const EXPECTED_SURFACE = [
  'RootConfigAdmin',
  'RootConfigDeps',
  'RootConfigLegacyMigration',
  'RootConfigReader',
  'createRootConfig',
  'createRootConfigLegacyMigration',
  'resolveLLMConfig',
];

// 内部符号：不得进入 barrel。（phase 1886 Step B: 兼容出口 buildLLMConfig 已随 alias 删除出列）
const FORBIDDEN = [
  'isInitialized', 'loadGlobalConfig', 'loadClawConfig', 'saveGlobalConfig', 'saveClawConfig',
  'patchGlobalConfigPrimary', 'clawExists', 'getGlobalConfigPath',
  'loadYamlConfig', 'writeYamlConfig', 'patchYamlConfig', 'configExists',
  'readLegacyAuditConfigSection', 'removeLegacyAuditConfigSection',
  'LegacyAuditConfigSection',
];

/** root-config.ts 违规 import（ConfigStore / FileSystem 实现）扫描。 */
function findIllegalImports(text: string): string[] {
  const lines = text.match(/^import\s[^]*?from\s*'[^']*'/gm) ?? [];
  return lines.filter(
    (l) => /foundation\/config-store/.test(l) || /foundation\/fs\/(node-fs|atomic|types)/.test(l),
  );
}

/** 模块级 mutable cache/singleton 扫描（root-config.ts 只允许函数与 type 声明）。 */
function findModuleLevelMutable(text: string): string[] {
  return text.match(/^(?:let|var)\s.*$|new\s(?:Map|Set|WeakMap|WeakSet)\s*[<(]/gm) ?? [];
}

describe('phase 1300: Assembly barrel RootConfig 精确新增表面', () => {
  it('RootConfig 相关新增集合精确为计划表面，且无禁止符号', () => {
    const text = fs.readFileSync(ASSEMBLY_BARREL, 'utf8');
    expect(text).not.toMatch(/export\s*\*/);
    const exports = parseBarrelExports(text);
    expect(rootConfigSurface(exports)).toEqual(EXPECTED_SURFACE);
    expect(exports.filter((n) => FORBIDDEN.includes(n))).toEqual([]);
  });

  it('反向 fixture：barrel 加入 clawExists / 缺 createRootConfig 必须被拒', () => {
    const text = fs.readFileSync(ASSEMBLY_BARREL, 'utf8');
    const withClawExists = parseBarrelExports(`${text}\nexport { clawExists } from './config/config-load.js';`);
    expect(rootConfigSurface(withClawExists)).toEqual(EXPECTED_SURFACE);
    expect(withClawExists.filter((n) => FORBIDDEN.includes(n))).toEqual(['clawExists']);
    const missing = parseBarrelExports(text.replace('createRootConfig, ', ''));
    expect(rootConfigSurface(missing)).not.toEqual(EXPECTED_SURFACE);
  });
});

describe('phase 1300: root-config.ts 只组合同模块 owner 函数', () => {
  it('不 import ConfigStore/FileSystem 实现，FileSystem 仅 type-only barrel 依赖', () => {
    const text = fs.readFileSync(ROOT_CONFIG_TS, 'utf8');
    expect(findIllegalImports(text)).toEqual([]);
    expect(text).toMatch(/import type \{[^}]*FileSystem[^}]*\} from '\.\.\/\.\.\/foundation\/fs\/index\.js'/);
    expect(text).toMatch(/from '\.\/config-load\.js'/);
  });

  it('反向 fixture：ConfigStore / node-fs import 必须被检出', () => {
    expect(findIllegalImports(`import { loadYamlConfig } from '../../foundation/config-store/index.js';`)).toHaveLength(1);
    expect(findIllegalImports(`import { NodeFileSystem } from '../../foundation/fs/node-fs.js';`)).toHaveLength(1);
    expect(findIllegalImports(`import { createRootConfig } from './root-config.js';`)).toEqual([]);
  });
});

describe('phase 1300: factory 无模块级 mutable cache', () => {
  it('root-config.ts 无模块级 let/var 与 Map/Set 实例', () => {
    const text = fs.readFileSync(ROOT_CONFIG_TS, 'utf8');
    expect(findModuleLevelMutable(text)).toEqual([]);
  });

  it('反向 fixture：模块级 cache 必须被检出', () => {
    expect(findModuleLevelMutable('let cache: X | undefined;')).toHaveLength(1);
    expect(findModuleLevelMutable('const memo = new Map<string, X>();')).toHaveLength(1);
    expect(findModuleLevelMutable('export function f() {\n  return 1;\n}')).toEqual([]);
  });
});
