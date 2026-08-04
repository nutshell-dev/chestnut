/**
 * Phase 1287 Step C: Watchdog 布局 owner 与 legacy IO 隔离 ratchet。
 *
 * Phase 1287 Step B 建立零 IO 布局协议（src/watchdog/layout.ts）并把 ownership
 * 目录常量改为派生后，本 ratchet 冻结：
 *  - WATCHDOG_PATHS / WATCHDOG_LEGACY_PATHS production 定义恰在
 *    watchdog/layout.ts 一处；目标/legacy 键值与 Phase 1286 逐项一致、不缺不溢；
 *  - layout 模块零 import、零 IO；
 *  - ownership 四个目录常量均从 WATCHDOG_PATHS 派生，文件内无目标路径字面；
 *  - Watchdog 外 production 模块不得 deep-import layout；模块内经 ./layout.js；
 *  - 阶段隔离：当前 state/subscription/log 生产 IO 仍在 legacy 位置，不得提前
 *    引用 target 值（非永久规则——后续资源迁移 Phase 必须显式校准本约束）。
 * 正反 fixture 自证 scanner 能识别模块外 owner 复制与合法模块内 import。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMPORT_SPECIFIER_RE, assemblyDir, walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(assemblyDir(), '..');
const PROJECT_ROOT = path.join(SRC_ROOT, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const WATCHDOG_DIR = path.join(SRC_ROOT, 'watchdog');
const LAYOUT_FILE = path.join(WATCHDOG_DIR, 'layout.ts');
const OWNERSHIP_FILE = path.join(WATCHDOG_DIR, 'watchdog-ownership.ts');
const INTERNAL_SPECIFIER = './layout.js';

const TARGET_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['root', 'watchdog'], ['layout', 'watchdog/layout.json'], ['config', 'watchdog/config.yaml'],
  ['state', 'watchdog/state.json'], ['log', 'watchdog/watchdog.log'],
  ['subscriptions', 'watchdog/subscriptions'], ['candidates', 'watchdog/candidates'],
  ['active', 'watchdog/active'], ['retired', 'watchdog/retired'],
  ['quarantine', 'watchdog/quarantine'], ['migrations', 'watchdog/migrations'],
];
const LEGACY_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['state', 'watchdog-state.json'], ['subscriptions', 'watchdog-subscriptions'],
  ['log', 'logs/watchdog.log'], ['pid', 'watchdog.pid'],
];

const DEFINITION_RE = /export\s+const\s+(WATCHDOG_PATHS|WATCHDOG_LEGACY_PATHS)\b/;
const IMPORT_CLAUSE_RE = /import\s+(?:type\s+)?([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g;

interface LayoutImport { file: string; specifier: string; }

/** 扫描 dir 下 .ts 文件中消费 layout 符号或 layout specifier 的 import。 */
function collectLayoutImports(dir: string): LayoutImport[] {
  const out: LayoutImport[] = [];
  for (const file of walkTsFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_CLAUSE_RE)) {
      const isLayoutSpecifier = m[2] === INTERNAL_SPECIFIER || m[2].includes('watchdog/layout');
      if (!m[1].includes('WATCHDOG_PATHS') && !m[1].includes('WATCHDOG_LEGACY_PATHS') && !isLayoutSpecifier) continue;
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

describe('phase 1287 Step C: Watchdog 布局 owner 边界', () => {
  it('WATCHDOG_PATHS / WATCHDOG_LEGACY_PATHS 定义恰在 watchdog/layout.ts', () => {
    const definitions = walkTsFiles(SRC_ROOT)
      .filter((f) => DEFINITION_RE.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PROJECT_ROOT, f));
    expect(definitions).toEqual(['src/watchdog/layout.ts']);
  });

  it('目标与 legacy 路径键值与 Phase 1286 逐项一致、无缺项无额外项', () => {
    const text = fs.readFileSync(LAYOUT_FILE, 'utf8');
    expect(text).toContain('export const WATCHDOG_LAYOUT_SCHEMA_VERSION = 1;');
    for (const [key, value] of TARGET_ENTRIES) expect(text).toContain(`${key}: '${value}'`);
    for (const [key, value] of LEGACY_ENTRIES) expect(text).toContain(`${key}: '${value}'`);
    expect(objectKeys(text, 'WATCHDOG_PATHS')).toEqual(TARGET_ENTRIES.map(([k]) => k));
    expect(objectKeys(text, 'WATCHDOG_LEGACY_PATHS')).toEqual(LEGACY_ENTRIES.map(([k]) => k));
  });

  it('layout 模块零 import、零 IO（纯静态常量协议）', () => {
    const text = fs.readFileSync(LAYOUT_FILE, 'utf8');
    expect([...text.matchAll(IMPORT_SPECIFIER_RE)]).toEqual([]);
  });

  it('ownership 目录常量全部自 WATCHDOG_PATHS 派生、无目标路径字面', () => {
    const text = fs.readFileSync(OWNERSHIP_FILE, 'utf8');
    expect(text).toContain('export const WATCHDOG_OWNERSHIP_DIR = WATCHDOG_PATHS.root;');
    expect(text).toContain('export const WATCHDOG_CANDIDATES_DIR = WATCHDOG_PATHS.candidates;');
    expect(text).toContain('export const WATCHDOG_ACTIVE_DIR = WATCHDOG_PATHS.active;');
    expect(text).toContain('export const WATCHDOG_RETIRED_DIR = WATCHDOG_PATHS.retired;');
    for (const literal of ["'watchdog'", "'watchdog/candidates'", "'watchdog/active'", "'watchdog/retired'"]) {
      expect(text.includes(literal), `ownership must not repeat ${literal}`).toBe(false);
    }
  });

  it('Watchdog 外 production 模块不得 deep-import layout；模块内经 ./layout.js', () => {
    for (const i of collectLayoutImports(SRC_ROOT)) {
      expect(i.file.startsWith('src/watchdog/'), `${i.file} must not consume layout outside Watchdog`).toBe(true);
      expect(i.specifier, `${i.file} must use module-local specifier`).toBe(INTERNAL_SPECIFIER);
    }
  });

  it('阶段隔离：state/subscription/log 生产 IO 仍在 legacy 位置、未提前引用 target（迁移 Phase 须校准本约束）', () => {
    const staged = ['watchdog-state.ts', 'subscription-store.ts', 'watchdog-log.ts', 'constants.ts'];
    const targets = ['watchdog/state.json', 'watchdog/subscriptions', 'watchdog/watchdog.log', 'WATCHDOG_PATHS'];
    for (const name of staged) {
      const text = fs.readFileSync(path.join(WATCHDOG_DIR, name), 'utf8');
      for (const t of targets) expect(text.includes(t), `${name} must not reference target ${t} yet`).toBe(false);
    }
  });

  it('scanner 正反 fixture 自证', () => {
    const hits = collectLayoutImports(FIXTURES_DIR);
    const violation = hits.find((h) => h.file.includes('watchdog-layout-outside-owner-violation'));
    expect(violation?.specifier).toContain('src/watchdog/layout');
    expect(violation?.file.startsWith('src/watchdog/')).toBe(false);
    const clean = hits.find((h) => h.file.includes('watchdog-layout-internal-clean'));
    expect(clean?.specifier).toBe(INTERNAL_SPECIFIER);
  });
});
