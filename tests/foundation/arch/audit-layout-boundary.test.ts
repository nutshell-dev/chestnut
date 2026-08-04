/**
 * Phase 1288 Step B: AuditLog 布局 owner 与 legacy IO 隔离 ratchet。
 * （比照 watchdog-layout-boundary.test.ts 模式 / Phase 1287 Step C）
 *
 * 冻结：
 *  - AUDIT_PATHS / AUDIT_LEGACY_PATHS production 定义恰在
 *    foundation/audit/layout.ts 一处；目标/legacy 键值与 Phase 1288 总览逐项一致；
 *  - layout 模块零 import、零 IO；
 *  - AuditLog 外 production 模块不得 deep-import layout.ts（layout 符号经 barrel
 *    foundation/audit/index.js 消费）；模块内 import 必须经 ./layout.js；
 *  - Step C 校准：根 audit.tsv 数据路径生产写入已切到 createWorkspaceAudit
 *    （AUDIT_PATHS.audit）；通用原语（writer/dispatching-writer/reader/
 *    dir-context）保持路径中立；Watchdog/CLI 根审计调用方零路径/retention/
 *    Assembly audit config 接触。
 * 正反 fixture 自证 scanner 能识别模块外 deep import 与合法模块内 import。
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
  ['audit', 'audit/audit.tsv'], ['migrations', 'audit/migrations'],
];
const LEGACY_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['audit', 'audit.tsv'], ['configSection', 'audit'],
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

  it('通用原语保持路径中立：writer/dispatching-writer/reader/dir-context 不得引用 target/legacy 数据路径', () => {
    // Step C 校准：target 数据路径的生产写入只允许出现在 workspace-audit.ts（createWorkspaceAudit）；
    // Step D 校准：segments 读取归 workspace-segments.ts、monitor 观察归 Assembly 装配，
    // 通用原语接收 caller 给的路径、自身不得硬编码 AUDIT_PATHS / AUDIT_LEGACY_PATHS / audit/audit.tsv。
    const staged = ['writer.ts', 'dispatching-writer.ts', 'reader.ts', 'dir-context.ts'];
    const targets = ['audit/audit.tsv', 'AUDIT_PATHS', 'AUDIT_LEGACY_PATHS'];
    for (const name of staged) {
      const text = fs.readFileSync(path.join(AUDIT_DIR, name), 'utf8');
      for (const t of targets) expect(text.includes(t), `${name} must stay path-agnostic (${t})`).toBe(false);
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

describe('phase 1288 Step C: workspace audit capability 接管根数据路径', () => {
  const WORKSPACE_AUDIT_FILE = path.join(AUDIT_DIR, 'workspace-audit.ts');
  // Watchdog 侧 audit wiring 三文件 + CLI 根审计调用方（stop）
  const ROOT_AUDIT_CALLERS = [
    'src/watchdog/audit-wiring.ts',
    'src/watchdog/watchdog.ts',
    'src/cli/commands/stop.ts',
  ];

  it('createWorkspaceAudit 是 workspace 根审计唯一工厂：固定 AUDIT_PATHS.audit + 自家 config store、经 barrel 导出', () => {
    const text = fs.readFileSync(WORKSPACE_AUDIT_FILE, 'utf8');
    expect(text).toContain('createWorkspaceAudit');
    expect(text).toContain('AUDIT_PATHS.audit');
    expect(text).toContain('readWorkspaceAuditRetentionMaxSizeMb');
    // 不暴露 maxSizeMb / AUDIT_FILE / raw config 给 caller（签名只接 fsFactory + chestnutRoot）
    const sig = text.match(/export function createWorkspaceAudit\(([\s\S]*?)\): AuditLog/);
    expect(sig, 'createWorkspaceAudit signature must exist').not.toBeNull();
    expect(sig![1]).toContain('fsFactory');
    expect(sig![1]).toContain('chestnutRoot');
    expect(sig![1]).not.toContain('maxSizeMb');
    const barrel = fs.readFileSync(path.join(AUDIT_DIR, 'index.ts'), 'utf8');
    expect(barrel).toContain("export { createWorkspaceAudit } from './workspace-audit.js';");
  });

  it('Watchdog/CLI 根审计调用方统一 createWorkspaceAudit、零路径/retention/config 接触', () => {
    const forbidden = ['createAuditWriter', 'AUDIT_FILE', 'readWorkspaceAuditRetentionMaxSizeMb'];
    for (const rel of [...ROOT_AUDIT_CALLERS, 'src/watchdog/watchdog-context.ts']) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      for (const token of forbidden) {
        expect(text.includes(token), `${rel} must not reference ${token}`).toBe(false);
      }
    }
    for (const rel of ROOT_AUDIT_CALLERS) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      expect(text.includes('createWorkspaceAudit'), `${rel} must construct via createWorkspaceAudit`).toBe(true);
    }
  });

  it('Watchdog audit wiring 零 Assembly config import（watchdog-context 仅保留自身 interval 消费、无 audit 段访问）', () => {
    for (const rel of ['src/watchdog/audit-wiring.ts', 'src/watchdog/watchdog.ts']) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      expect(text.includes('assembly/config'), `${rel} must not import Assembly config for audit`).toBe(false);
    }
    // watchdog-context.ts 保留 loadGlobalConfig（watchdog.interval_ms / claw_inactivity_timeout_ms
    // 等自身消费，Phase 1288 不迁 Watchdog 自身配置），但不得访问 audit 配置段
    const ctx = fs.readFileSync(path.join(PROJECT_ROOT, 'src/watchdog/watchdog-context.ts'), 'utf8');
    expect(ctx).toContain('loadGlobalConfig');
    expect(ctx.includes('audit.retention')).toBe(false);
    expect(/config\.audit\b/.test(ctx)).toBe(false);
    expect(/globalConfig\.audit\b/i.test(ctx)).toBe(false);
  });
});

describe('phase 1288 Step D: legacy 根 audit 只读与 segments 边界 ratchet', () => {
  // legacy/目标数据路径引用白名单（校准而非删除所有权语义）：
  //  - workspace-audit.ts   唯一生产写 audit/audit.tsv（createWorkspaceAudit）
  //  - workspace-segments.ts 唯一 segments 读取消费方（legacy/new 双段、只读）
  //  - motion-addons.ts     monitor 三段常驻观察装配（stat 观察、不写）
  const TARGET_AUDIT_REF_FILES = [
    'src/foundation/audit/workspace-audit.ts',
    'src/foundation/audit/workspace-segments.ts',
    'src/assembly/motion-addons.ts',
  ];
  const LEGACY_AUDIT_REF_FILES = [
    'src/foundation/audit/workspace-segments.ts',
    'src/assembly/motion-addons.ts',
  ];
  const MUTATION_TOKENS = [
    'writeSync(', 'writeFileSync(', 'appendSync(', 'appendFileSync(',
    'renameSync(', 'moveSync(', 'rmSync(', 'unlinkSync(', 'writeAtomicSync(', 'removeSync(',
  ];

  function filesReferencing(token: string, dir: string): string[] {
    return walkTsFiles(dir)
      .filter((f) => fs.readFileSync(f, 'utf8').includes(token))
      .map((f) => path.relative(PROJECT_ROOT, f));
  }

  function mutationTokensIn(rel: string): string[] {
    const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
    return MUTATION_TOKENS.filter((t) => text.includes(t));
  }

  it('目标 writer 唯一：AUDIT_PATHS.audit 引用白名单恰三处、唯 workspace-audit.ts 构造 AuditWriter', () => {
    expect(filesReferencing('AUDIT_PATHS.audit', SRC_ROOT).sort()).toEqual([...TARGET_AUDIT_REF_FILES].sort());
    for (const rel of TARGET_AUDIT_REF_FILES) {
      const text = fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
      if (rel.endsWith('workspace-audit.ts')) {
        expect(text).toContain('new AuditWriter');
      } else {
        expect(text.includes('new AuditWriter'), `${rel} must not construct audit writers`).toBe(false);
      }
    }
  });

  it('legacy 根 audit.tsv 只读：AUDIT_LEGACY_PATHS.audit 引用白名单恰两处、零写/删/移/改名操作', () => {
    expect(filesReferencing('AUDIT_LEGACY_PATHS.audit', SRC_ROOT).sort()).toEqual([...LEGACY_AUDIT_REF_FILES].sort());
    for (const rel of LEGACY_AUDIT_REF_FILES) {
      expect(mutationTokensIn(rel), `${rel} must not mutate legacy audit`).toEqual([]);
    }
  });

  it('其他 scope（motion/claw/tick/viewport）审计路径零迁移、值保持原值', () => {
    const writer = fs.readFileSync(path.join(AUDIT_DIR, 'writer.ts'), 'utf8');
    expect(writer).toContain("export const AUDIT_FILE = 'audit.tsv';");
    const types = fs.readFileSync(path.join(AUDIT_DIR, 'types.ts'), 'utf8');
    expect(types).toContain("export type AuditFileName = 'audit' | 'tick' | 'viewport';");
    // motion audit 主观察路径保持 motion/audit.tsv
    const addons = fs.readFileSync(path.join(PROJECT_ROOT, 'src/assembly/motion-addons.ts'), 'utf8');
    expect(addons).toContain("primaryAuditPath: path.join(chestnutRoot, 'motion', AUDIT_FILE)");
    // tick 分流保持原值（daemon liveness / eventloop iteration → tick.tsv）
    const daemonEvents = fs.readFileSync(path.join(PROJECT_ROOT, 'src/daemon/audit-events.ts'), 'utf8');
    expect(daemonEvents).toContain("daemon_liveness_heartbeat: 'tick'");
    const eventloopEvents = fs.readFileSync(path.join(PROJECT_ROOT, 'src/core/event-loop/audit-events.ts'), 'utf8');
    expect(eventloopEvents).toContain("eventloop_iteration: 'tick'");
    // viewport 分流保持原值
    const viewportEvents = fs.readFileSync(path.join(PROJECT_ROOT, 'src/cli/commands/viewport-audit-events.ts'), 'utf8');
    expect(viewportEvents).toContain("'viewport'");
  });

  it('legacy 写操作 scanner 正反 fixture 自证', () => {
    const refs = filesReferencing('AUDIT_LEGACY_PATHS.audit', FIXTURES_DIR);
    const violation = refs.find((f) => f.includes('audit-legacy-write-violation'));
    expect(violation).toBeDefined();
    expect(mutationTokensIn(violation!)).toContain('appendFileSync(');
    const clean = refs.find((f) => f.includes('audit-legacy-readonly-clean'));
    expect(clean).toBeDefined();
    expect(mutationTokensIn(clean!)).toEqual([]);
  });
});
