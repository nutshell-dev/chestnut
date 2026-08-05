/**
 * Phase 1297 Step C: ConfigStore 物理边界与最小 barrel ratchet。
 *
 * 冻结四条 module invariant：
 * 1. 物理归属：旧位置 src/assembly/config/config-loader.ts 消失，
 *    实现位于 src/foundation/config-store/store.ts；
 * 2. 依赖方向：ConfigStore production import 只允许 bare package（含 Node
 *    builtin）、模块内部相对路径与 foundation/fs barrel；
 * 3. 零上层业务符号：ConfigStore 源码（含注释）不出现
 *    assembly|root|claw|watchdog|audit|llm 文本；
 * 4. 唯一 caller 经 barrel：src 内对 ConfigStore 的 import 只有
 *    assembly/config/config-load.ts 一条边、且必须指向 index barrel，
 *    barrel 无 export *、导出集合精确匹配 phase 1297 计划表面。
 *
 * scanner 均带反向 fixture 自证（不是恒真断言）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IMPORT_SPECIFIER_RE,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(__dirname, '..', '..', '..', 'src');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const CONFIG_STORE_DIR = path.join(SRC_ROOT, 'foundation', 'config-store');
const CONFIG_STORE_BARREL = path.join(CONFIG_STORE_DIR, 'index');
const FS_BARREL = path.join(SRC_ROOT, 'foundation', 'fs', 'index');
const OLD_LOADER_PATH = path.join(SRC_ROOT, 'assembly', 'config', 'config-loader.ts');

const BUSINESS_TOKEN_RE = /assembly|root|claw|watchdog|audit|llm/i;

/** 剥离 .js/.ts 扩展名，供模块级比较。 */
function stripExtension(p: string): string {
  return p.replace(/\.(js|ts)$/, '');
}

interface ImportEdge {
  /** PROJECT_ROOT 相对路径的 import 方文件。 */
  file: string;
  specifier: string;
  /** 相对 specifier 解析后的绝对路径（未剥扩展名）。 */
  resolved: string;
}

/** 收集 dir 下 .ts 文件的相对 import/export specifier（静态）。 */
function collectRelativeImportEdges(dir: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = m[1];
      if (!specifier.startsWith('.')) continue;
      edges.push({
        file: path.relative(PROJECT_ROOT, file),
        specifier,
        resolved: path.resolve(path.dirname(file), specifier),
      });
    }
  }
  return edges;
}

/**
 * ConfigStore 内部文件的一条相对 import 是否合法：
 * 只允许模块内部文件（./store.js、./errors.js）与 FileSystem barrel。
 */
function isAllowedConfigStoreRelative(resolved: string): boolean {
  if ((resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep)) return true;
  if (resolved === CONFIG_STORE_DIR) return true;
  return stripExtension(resolved) === FS_BARREL;
}

/** 解析路径是否指向 ConfigStore barrel（而非 deep-import）。 */
function isConfigStoreBarrel(resolved: string): boolean {
  return stripExtension(resolved) === CONFIG_STORE_BARREL;
}

/** 解析路径是否落入 ConfigStore 模块。 */
function isInsideConfigStore(resolved: string): boolean {
  return (resolved + path.sep).startsWith(CONFIG_STORE_DIR + path.sep);
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
  'ConfigSchema',
  'ConfigStoreError',
  'ConfigStoreErrorCode',
  'LoaderDeps',
  'configExists',
  'isConfigStoreError',
  'loadYamlConfig',
  'patchYamlConfig',
  'writeYamlConfig',
];

describe('phase 1297 Step C: ConfigStore 物理归属', () => {
  it('旧位置 config-loader.ts 消失、实现位于 ConfigStore', () => {
    expect(fs.existsSync(OLD_LOADER_PATH)).toBe(false);
    expect(fs.existsSync(path.join(CONFIG_STORE_DIR, 'store.ts'))).toBe(true);
    expect(fs.existsSync(path.join(CONFIG_STORE_DIR, 'errors.ts'))).toBe(true);
    expect(fs.existsSync(path.join(CONFIG_STORE_DIR, 'index.ts'))).toBe(true);
  });
});

describe('phase 1297 Step C: ConfigStore 依赖方向', () => {
  it('production 相对 import 只允许模块内部与 foundation/fs barrel', () => {
    const edges = collectRelativeImportEdges(CONFIG_STORE_DIR);
    const violations = edges.filter((e) => !isAllowedConfigStoreRelative(e.resolved));
    expect(violations).toEqual([]);
  });

  it('正向自证：确实消费 foundation/fs barrel 且存在模块内部边（scanner 非恒真）', () => {
    const edges = collectRelativeImportEdges(CONFIG_STORE_DIR);
    expect(edges.some((e) => stripExtension(e.resolved) === FS_BARREL)).toBe(true);
    expect(edges.some((e) => isInsideConfigStore(e.resolved))).toBe(true);
  });

  it('反向 fixture：指向 ConfigStore 外的相对 import 必须被判定违规', () => {
    const fakeFile = path.join(CONFIG_STORE_DIR, 'store.ts');
    const toUpperLayer = path.resolve(path.dirname(fakeFile), '../../assembly/config/config-load.js');
    expect(isAllowedConfigStoreRelative(toUpperLayer)).toBe(false);
    const toOtherFoundation = path.resolve(path.dirname(fakeFile), '../node-utils/index.js');
    expect(isAllowedConfigStoreRelative(toOtherFoundation)).toBe(false);
    expect(isAllowedConfigStoreRelative(path.resolve(path.dirname(fakeFile), '../fs/index.js'))).toBe(true);
    expect(isAllowedConfigStoreRelative(path.resolve(path.dirname(fakeFile), './errors.js'))).toBe(true);
  });
});

describe('phase 1297 Step C: ConfigStore 零上层业务符号', () => {
  it('源码（含注释）不出现 assembly|root|claw|watchdog|audit|llm', () => {
    const hits: string[] = [];
    for (const file of walkTsFiles(CONFIG_STORE_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (BUSINESS_TOKEN_RE.test(line)) {
          hits.push(`${path.relative(PROJECT_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('反向 fixture：业务符号样例必须被 token 正则命中', () => {
    expect(BUSINESS_TOKEN_RE.test('caller 决定 root config 文案')).toBe(true);
    expect(BUSINESS_TOKEN_RE.test('L6 Assembly')).toBe(true);
    expect(BUSINESS_TOKEN_RE.test('patch llm.primary')).toBe(true);
    expect(BUSINESS_TOKEN_RE.test('schema 参数化的 generic persistence')).toBe(false);
  });
});

describe('phase 1297 Step C: ConfigStore 唯一 caller 经 barrel', () => {
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

describe('phase 1297 Step C: ConfigStore 最小 barrel 表面', () => {
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
