/**
 * Phase 1288 Step B: AuditLog 布局 owner 与 legacy IO 隔离 ratchet。
 * （比照 watchdog-layout-boundary.test.ts 模式 / Phase 1287 Step C）
 *
 * 冻结：
 *  - AUDIT_PATHS / AUDIT_LEGACY_PATHS production 定义恰在
 *    foundation/audit/layout.ts 一处；目标/legacy 键值与 Phase 1288 总览逐项一致；
 *  - layout 模块零 import、零 IO；
 *  - AuditLog 外 production 模块不得 deep-import layout.ts（layout 符号经 barrel
 *    foundation/audit/index.js 消费）；模块内 import 必须经 ./layout.js。
 * 正反 fixture 自证 scanner 能识别模块外 deep import 与合法模块内 import。
 *
 * （Step C workspace audit capability / Step D legacy 只读 ratchet 在
 *  audit-workspace-audit-boundary.test.ts 与 audit-legacy-readonly-boundary.test.ts。）
 *
 * phase 1890 Step L：迁移 journal 退役——AUDIT_PATHS.migrations 与
 * AUDIT_LEGACY_PATHS.configSection 键随删。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMPORT_SPECIFIER_RE, assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const AUDIT_DIR = path.join(SRC_ROOT, 'foundation', 'audit');
const LAYOUT_FILE = path.join(AUDIT_DIR, 'layout.ts');
const INTERNAL_SPECIFIER = './layout.js';

const TARGET_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['root', 'audit'], ['layout', 'audit/layout.json'], ['config', 'audit/config.yaml'],
  ['audit', 'audit/audit.tsv'],
];
const LEGACY_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['audit', 'audit.tsv'],
];

const DEFINITION_RE = /export\s+const\s+(AUDIT_PATHS|AUDIT_LEGACY_PATHS)\b/;
const IMPORT_CLAUSE_RE = /import\s+(?:type\s+)?([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g;

interface LayoutImport { file: string; specifier: string; }

/** 违规判定：模块内必须 ./layout.js；模块外不得出现 audit/layout 深链 specifier。 */
function layoutImportViolation(i: LayoutImport): string | undefined {
  if (i.file.startsWith('src/foundation/audit/')) {
    return i.specifier === INTERNAL_SPECIFIER ? undefined : 'module-internal must use ./layout.js';
  }
  return i.specifier.includes('audit/layout')
    ? 'outside AuditLog must consume layout symbols via barrel, not deep-import'
    : undefined;
}

/** 扫描 dir 下 .ts 文件中消费 layout 符号或 layout specifier 的 import。 */
function collectLayoutImports(dir: string): LayoutImport[] {
  const out: LayoutImport[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_CLAUSE_RE)) {
      const isLayoutSpecifier = m[2] === INTERNAL_SPECIFIER || m[2].includes('audit/layout');
      if (!m[1].includes('AUDIT_PATHS') && !m[1].includes('AUDIT_LEGACY_PATHS') && !isLayoutSpecifier) continue;
      out.push({ file: path.relative(PROJECT_ROOT, file), specifier: m[2] });
    }
  }
  return out;
}

function objectKeys(text: string, name: string): string[] {
  const body = text.match(new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`));
  expect(body, `${name} literal object must exist`).not.toBeNull();
  return [...body![1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

describe('phase 1288 Step B: AuditLog 布局 owner 边界', () => {
  it('AUDIT_PATHS / AUDIT_LEGACY_PATHS 定义恰在 foundation/audit/layout.ts', () => {
    const definitions = walkTsFiles(SRC_ROOT)
      .filter((f) => DEFINITION_RE.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PROJECT_ROOT, f));
    expect(definitions).toEqual(['src/foundation/audit/layout.ts']);
  });

  it('目标与 legacy 路径键值与 Phase 1288 总览逐项一致、无缺项无额外项', () => {
    const text = fs.readFileSync(LAYOUT_FILE, 'utf8');
    expect(text).toContain('export const AUDIT_LAYOUT_SCHEMA_VERSION = 1;');
    for (const [key, value] of TARGET_ENTRIES) expect(text).toContain(`${key}: '${value}'`);
    for (const [key, value] of LEGACY_ENTRIES) expect(text).toContain(`${key}: '${value}'`);
    expect(objectKeys(text, 'AUDIT_PATHS')).toEqual(TARGET_ENTRIES.map(([k]) => k));
    expect(objectKeys(text, 'AUDIT_LEGACY_PATHS')).toEqual(LEGACY_ENTRIES.map(([k]) => k));
  });

  it('layout 模块零 import、零 IO（纯静态常量协议）', () => {
    const text = fs.readFileSync(LAYOUT_FILE, 'utf8');
    expect([...text.matchAll(IMPORT_SPECIFIER_RE)]).toEqual([]);
  });

  it('AuditLog 外 production 模块不得 deep-import layout.ts；模块内经 ./layout.js', () => {
    for (const i of collectLayoutImports(SRC_ROOT)) {
      expect(layoutImportViolation(i), `${i.file} (${i.specifier})`).toBeUndefined();
    }
  });

  it('scanner 正反 fixture 自证', () => {
    const hits = collectLayoutImports(FIXTURES_DIR);
    const violation = hits.find((h) => h.file.includes('audit-layout-outside-owner-violation'));
    expect(violation?.specifier).toContain('src/foundation/audit/layout');
    expect(layoutImportViolation(violation!)).toBeDefined();
    const clean = hits.find((h) => h.file.includes('audit-layout-internal-clean'));
    expect(clean?.specifier).toBe(INTERNAL_SPECIFIER);
    expect(layoutImportViolation({ file: 'src/foundation/audit/x.ts', specifier: clean!.specifier })).toBeUndefined();
  });
});
