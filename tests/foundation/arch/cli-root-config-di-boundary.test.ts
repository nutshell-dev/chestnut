/**
 * Phase 1301 Step C: CLI RootConfig DI 边界 ratchet。
 *
 * 冻结四条 invariant（scanner 均带反向 fixture 自证）：
 * 1. cli/index.ts 只从 Assembly barrel 取 createRootConfig，构造文本恰好 1 处；
 * 2. cli/index.ts 与 commands/claw-router.ts 零 `assembly/config/**` import；
 * 3. RouterDeps 含 required 窄 Pick（不得 optional / 不得 Admin 宽面）；
 * 4. CLI production 下 `assembly/config/config-load.js` importer 精确为下方 24 文件
 *    migration baseline——只防新增与意外删除，不批准永久存在；后续每个命令族
 *    治理 phase 必须同步递减本清单。
 * 5. clawExists 不得回到 router。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI_ROOT = path.resolve(__dirname, '..', '..', '..', 'src', 'cli');
const INDEX_TS = path.join(CLI_ROOT, 'index.ts');
const ROUTER_TS = path.join(CLI_ROOT, 'commands', 'claw-router.ts');
const AUDIT_COMMANDS = ['audit-info.ts', 'audit-lookup.ts', 'audit-query.ts'];

/** 静态（含 multiline / type）与 dynamic import specifier 扫描。 */
function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re = /import(?:\s+type)?[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) specs.push((m[1] ?? m[2]) as string);
  return specs;
}

function listTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listTsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** CLI production 下 import `assembly/config/config-load.js` 的相对路径集合。 */
function configLoadImporters(): string[] {
  return listTsFiles(CLI_ROOT)
    .filter((f) => importSpecifiers(fs.readFileSync(f, 'utf8')).some((s) => s.endsWith('assembly/config/config-load.js')))
    .map((f) => path.relative(CLI_ROOT, f))
    .sort();
}

// Migration baseline（phase 1323 Step C）：精确路径集合，非计数；一删一增抵消会被拒。
const REMAINING_BASELINE = [
  'audit-config-migration.ts', 'commands/claw-chat.ts', 'commands/claw-create.ts',
  'commands/claw-daemon.ts', 'commands/claw-health.ts', 'commands/claw-import.ts',
  'commands/claw-list.ts', 'commands/claw-ls.ts', 'commands/claw-read.ts',
  'commands/claw-send.ts', 'commands/claw-status.ts', 'commands/claw-stop.ts',
  'commands/claw-stream.ts', 'commands/claw-trace.ts', 'commands/claw-watch.ts',
  'commands/config.ts', 'commands/init.ts', 'commands/motion-daemon.ts',
  'commands/motion.ts', 'commands/start.ts', 'commands/status.ts',
  'commands/stop.ts', 'llm-connection-check.ts', 'watchdog-config-migration.ts',
].sort();

const NARROW_PICK = /rootConfig:\s*Pick<RootConfigReader,\s*'loadGlobal'\s*\|\s*'loadClaw'>/;

describe('phase 1301: CLI composition root 唯一构造', () => {
  it('index.ts 从 barrel 取 createRootConfig 且构造恰好 1 处', () => {
    const text = fs.readFileSync(INDEX_TS, 'utf8');
    expect(importSpecifiers(text).filter((s) => s.includes('assembly/config/'))).toEqual([]);
    expect(text).toMatch(/import \{[^}]*createRootConfig[^}]*\} from '\.\.\/assembly\/index\.js'/);
    expect(text.match(/createRootConfig\(\{ fsFactory \}\)/g)).toHaveLength(1);
  });

  it('反向 fixture：第二次构造 / config internal import 必须被检出', () => {
    expect('createRootConfig({ fsFactory });\ncreateRootConfig({ fsFactory });'.match(/createRootConfig\(\{ fsFactory \}\)/g)).toHaveLength(2);
    const bad = importSpecifiers(`import { x } from '../assembly/config/config-load.js';`);
    expect(bad.some((s) => s.includes('assembly/config/'))).toBe(true);
    // multiline 与 dynamic import 同被 scanner 覆盖
    expect(importSpecifiers("import {\n  y,\n} from '../assembly/config/compose-config.js';")[0]).toContain('assembly/config/');
    expect(importSpecifiers("const m = await import('../assembly/config/config-load.js');")[0]).toContain('assembly/config/');
  });
});

describe('phase 1301: index/router 零 Assembly config internal 依赖', () => {
  it('index.ts 与 claw-router.ts 无 assembly/config/** import，clawExists 不在 router', () => {
    for (const f of [INDEX_TS, ROUTER_TS]) {
      const text = fs.readFileSync(f, 'utf8');
      expect(importSpecifiers(text).filter((s) => s.includes('assembly/config/'))).toEqual([]);
    }
    expect(fs.readFileSync(ROUTER_TS, 'utf8')).not.toMatch(/\bclawExists\b/);
  });

  it('反向 fixture：router 加 deep import / clawExists 必须被检出', () => {
    const bad = `import { clawExists } from '../../assembly/config/config-load.js';`;
    expect(importSpecifiers(bad).filter((s) => s.includes('assembly/config/'))).toHaveLength(1);
    expect(bad).toMatch(/\bclawExists\b/);
  });
});

describe('phase 1301: RouterDeps required 窄 Pick', () => {
  it('RouterDeps 含 required 窄 Pick，无 optional / Admin', () => {
    const text = fs.readFileSync(ROUTER_TS, 'utf8');
    expect(text).toMatch(NARROW_PICK);
    expect(text).not.toMatch(/rootConfig\?:/);
    expect(text).not.toMatch(/RootConfigAdmin/);
  });

  it('反向 fixture：optional / Admin 宽面必须被检出', () => {
    expect("rootConfig?: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>;").not.toMatch(NARROW_PICK);
    expect('rootConfig: RootConfigAdmin;').not.toMatch(NARROW_PICK);
  });
});

describe('phase 1301: remaining deep-caller migration baseline', () => {
  it('config-load.js importer 精确为 24 文件路径集合', () => {
    expect(configLoadImporters()).toEqual(REMAINING_BASELINE);
  });

  it('反向 fixture：新增 / 意外删除 / 一删一增均被检出', () => {
    const added = [...REMAINING_BASELINE, 'commands/new-caller.ts'].sort();
    expect(added).not.toEqual(REMAINING_BASELINE);
    const removed = REMAINING_BASELINE.filter((f) => f !== 'commands/init.ts');
    expect(removed).not.toEqual(REMAINING_BASELINE);
    const swap = [...removed, 'commands/other.ts'].sort();
    expect(swap).toHaveLength(REMAINING_BASELINE.length);
    expect(swap).not.toEqual(REMAINING_BASELINE);
  });
});

describe('phase 1323: Audit command family RootConfig DI boundary', () => {
  it('三个命令只接 shared narrow deps，且 composition root 注入同一 reader', () => {
    for (const file of AUDIT_COMMANDS) {
      const text = fs.readFileSync(path.join(CLI_ROOT, 'commands', file), 'utf8');
      expect(importSpecifiers(text).filter((s) => s.includes('assembly/config/'))).toEqual([]);
      expect(importSpecifiers(text)).toContain('./audit-command-deps.js');
      expect(text).toMatch(/deps:\s*AuditCommandDeps/);
    }
    const index = fs.readFileSync(INDEX_TS, 'utf8');
    expect(index.match(/audit(?:Query|Lookup|Info)Command\(\{ fsFactory, rootConfig \}/g)).toHaveLength(3);
  });

  it('反向 fixture：命令回退 deep import 或 composition root 漏注入会被检出', () => {
    expect(importSpecifiers("import { loadGlobalConfig } from '../../assembly/config/config-load.js';"))
      .toContain('../../assembly/config/config-load.js');
    expect('auditQueryCommand({ fsFactory }, opts)').not.toMatch(/\{ fsFactory, rootConfig \}/);
  });
});
