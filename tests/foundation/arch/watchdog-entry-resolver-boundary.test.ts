/**
 * Phase 1285 Step B: Watchdog entry resolver owner/consumer 边界 ratchet。
 *
 * Phase 1285 Step A 将 resolveWatchdogEntry 自 Assembly 归位 Watchdog 真 owner
 * （src/watchdog/entry-resolver.ts）后，本 ratchet 冻结：
 *  - production 定义恰一处且在 watchdog/entry-resolver.ts；
 *  - resolver 零参数签名、只依赖 node path/url 原语，不 import FileSystem /
 *    Assembly / Watchdog 运行实现；
 *  - 唯一内部消费者 watchdog-context.ts 经模块内 `./entry-resolver.js` 导入，
 *    并以零参数公共查询 getWatchdogEntryPath() 委托；
 *  - production 外部 consumer 只经 Watchdog 公共表面（watchdog/watchdog.js）
 *    消费 getWatchdogEntryPath，CLI 不得 deep-import 内部 resolver；
 *  - assembly/spawn-entry.ts 物理不存在，Assembly 无 resolver symbol 与
 *    watchdog-entry.js 字面。
 * 正反 fixture 自证 scanner 能识别旧 Assembly import、CLI deep import 与合法
 * Watchdog 内部 import。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMPORT_SPECIFIER_RE, assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ASSEMBLY_DIR = path.join(SRC_ROOT, 'assembly');
const ENTRY_RESOLVER = path.join(SRC_ROOT, 'watchdog', 'entry-resolver.ts');
const WATCHDOG_CONTEXT = path.join(SRC_ROOT, 'watchdog', 'watchdog-context.ts');
const SPAWN_ENTRY = path.join(ASSEMBLY_DIR, 'spawn-entry.ts');
const INTERNAL_SPECIFIER = './entry-resolver.js';
const PUBLIC_BARREL_SUFFIX = 'watchdog/watchdog.js';

/** 完整 import 语句的 clause + specifier（global flag：只供 matchAll 使用）。 */
const IMPORT_CLAUSE_RE = /import\s+(?:type\s+)?([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
const DEFINITION_RE = /export\s+function\s+resolveWatchdogEntry/;
const PUBLIC_QUERY = 'getWatchdogEntryPath';

interface SymbolImport {
  /** PROJECT_ROOT 相对路径的 import 方文件。 */
  file: string;
  specifier: string;
}

/** 扫描 dir 下 .ts 文件中 clause 含 symbol 的 import。 */
function collectSymbolImports(dir: string, symbol: string): SymbolImport[] {
  const out: SymbolImport[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_CLAUSE_RE)) {
      if (!m[1].includes(symbol)) continue;
      out.push({ file: path.relative(PROJECT_ROOT, file), specifier: m[2] });
    }
  }
  return out;
}

describe('phase 1285 Step B: Watchdog entry resolver 归属边界', () => {
  it('production resolveWatchdogEntry 定义恰在 watchdog/entry-resolver.ts 一处', () => {
    const definitions = walkTsFiles(SRC_ROOT)
      .filter((f) => DEFINITION_RE.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PROJECT_ROOT, f));
    expect(definitions).toEqual(['src/watchdog/entry-resolver.ts']);
  });

  it('resolver 零参数签名、只依赖 node 路径原语', () => {
    const text = fs.readFileSync(ENTRY_RESOLVER, 'utf8');
    expect(text).toMatch(/export function resolveWatchdogEntry\(\)/);
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]);
    // 只允许 node builtin 路径原语；fs/Assembly/Watchdog 运行实现均不得出现
    expect(specifiers.sort()).toEqual(['path', 'url']);
  });

  it('watchdog-context 经模块内稳定子入口导入并零参数委托', () => {
    const text = fs.readFileSync(WATCHDOG_CONTEXT, 'utf8');
    expect(text).toMatch(
      /import\s*\{[^}]*resolveWatchdogEntry[^}]*\}\s*from\s*['"]\.\/entry-resolver\.js['"]/,
    );
    expect(text).toMatch(/export function getWatchdogEntryPath\(\): string \{\s*return resolveWatchdogEntry\(\);\s*\}/);
  });

  it('production 内部 resolver import 恰一处且无外部 deep import', () => {
    expect(collectSymbolImports(SRC_ROOT, 'resolveWatchdogEntry')).toEqual([
      { file: 'src/watchdog/watchdog-context.ts', specifier: INTERNAL_SPECIFIER },
    ]);
  });

  it('外部 consumer 只经 Watchdog 公共表面消费 getWatchdogEntryPath', () => {
    const external = collectSymbolImports(SRC_ROOT, PUBLIC_QUERY)
      .filter((i) => !i.file.startsWith('src/watchdog/'));
    expect(external.length).toBeGreaterThan(0);
    for (const i of external) {
      expect(i.specifier.endsWith(PUBLIC_BARREL_SUFFIX), `${i.file} must use public barrel`).toBe(true);
      expect(i.specifier).not.toContain('entry-resolver');
    }
  });

  it('Assembly 零残留：旧文件物理删除、无 resolver symbol 与 entry 字面', () => {
    expect(fs.existsSync(SPAWN_ENTRY)).toBe(false);
    for (const file of walkTsFiles(ASSEMBLY_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      expect(DEFINITION_RE.test(text), `${file} must not define resolver`).toBe(false);
      expect(text.includes('watchdog-entry.js'), `${file} must not hold entry literal`).toBe(false);
    }
  });

  it('scanner 正反 fixture 自证', () => {
    const hits = collectSymbolImports(FIXTURES_DIR, 'resolveWatchdogEntry');
    const assemblyViolation = hits.find((h) => h.file.includes('watchdog-entry-resolver-assembly-import-violation'));
    expect(assemblyViolation?.specifier).toContain('assembly/spawn-entry');
    const deepImportViolation = hits.find((h) => h.file.includes('watchdog-entry-resolver-cli-deep-import-violation'));
    expect(deepImportViolation?.specifier).toContain('watchdog/entry-resolver');
    expect(deepImportViolation?.specifier).not.toBe(INTERNAL_SPECIFIER);
    const clean = hits.find((h) => h.file.includes('watchdog-entry-resolver-internal-clean'));
    expect(clean?.specifier).toBe(INTERNAL_SPECIFIER);
  });
});
