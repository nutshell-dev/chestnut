/**
 * Phase 1301 Step C: CLI RootConfig DI 边界 ratchet。
 *
 * 冻结 invariant（scanner 均带反向 fixture 自证；scanner/baseline 见
 * cli-root-config-di-boundary-fixtures.ts，phase 1324 Step C 抽出）：
 * 1. cli/index.ts 只从 Assembly barrel 取 createRootConfig，构造文本恰好 1 处；
 * 2. cli/index.ts 与 commands/claw-router.ts 零 `assembly/config/**` import；
 * 3. ClawCommandDeps 含 required 窄 Pick（不得 optional / 不得 Admin 宽面），
 *    RouterDeps 为同形状 type alias（phase 1324 Step A 收敛）；
 * 4. CLI production 下 `assembly/config/config-load.js` importer 精确为 20 文件
 *    migration baseline——只防新增与意外删除，不批准永久存在；后续每个命令族
 *    治理 phase 必须同步递减本清单；
 * 5. clawExists 不得回到 router；
 * 6. phase 1324/1325：claw read/ls 零 Assembly config internal；health/status 零旧
 *    config-load离散函数；四者共享ClawCommandDeps。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLI_ROOT,
  INDEX_TS,
  ROUTER_TS,
  CLAW_DEPS_TS,
  AUDIT_COMMANDS,
  CLAWSPACE_COMMANDS,
  CLAW_INSPECTION_COMMANDS,
  importSpecifiers,
  configLoadImporters,
  REMAINING_BASELINE,
  NARROW_PICK,
} from './cli-root-config-di-boundary-fixtures.js';

const read = (f: string): string => fs.readFileSync(f, 'utf8');

describe('phase 1301: CLI composition root 唯一构造', () => {
  it('index.ts 从 barrel 取 createRootConfig 且构造恰好 1 处', () => {
    const text = read(INDEX_TS);
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
      expect(importSpecifiers(read(f)).filter((s) => s.includes('assembly/config/'))).toEqual([]);
    }
    expect(read(ROUTER_TS)).not.toMatch(/\bclawExists\b/);
  });

  it('反向 fixture：router 加 deep import / clawExists 必须被检出', () => {
    const bad = `import { clawExists } from '../../assembly/config/config-load.js';`;
    expect(importSpecifiers(bad).filter((s) => s.includes('assembly/config/'))).toHaveLength(1);
    expect(bad).toMatch(/\bclawExists\b/);
  });
});

describe('phase 1301/1324: 共享窄 Pick + RouterDeps required alias', () => {
  it('ClawCommandDeps 含 required 窄 Pick；RouterDeps 为 alias，均无 optional / Admin', () => {
    const depsText = read(CLAW_DEPS_TS);
    expect(depsText).toMatch(NARROW_PICK);
    expect(depsText).not.toMatch(/rootConfig\?:/);
    expect(depsText).not.toMatch(/RootConfigAdmin/);
    const router = read(ROUTER_TS);
    expect(importSpecifiers(router)).toContain('./claw-command-deps.js');
    expect(router).toMatch(/export type RouterDeps = ClawCommandDeps;/);
    expect(router).not.toMatch(/rootConfig\?:/);
    expect(router).not.toMatch(/RootConfigAdmin/);
  });

  it('反向 fixture：optional / Admin 宽面必须被检出', () => {
    expect("rootConfig?: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>;").not.toMatch(NARROW_PICK);
    expect('rootConfig: RootConfigAdmin;').not.toMatch(NARROW_PICK);
  });
});

describe('phase 1301: remaining deep-caller migration baseline', () => {
  it('config-load.js importer 精确为 20 文件路径集合（phase 1325 迁出 health/status）', () => {
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
      const text = read(path.join(CLI_ROOT, 'commands', file));
      expect(importSpecifiers(text).filter((s) => s.includes('assembly/config/'))).toEqual([]);
      expect(importSpecifiers(text)).toContain('./audit-command-deps.js');
      expect(text).toMatch(/deps:\s*AuditCommandDeps/);
    }
    const index = read(INDEX_TS);
    expect(index.match(/audit(?:Query|Lookup|Info)Command\(\{ fsFactory, rootConfig \}/g)).toHaveLength(3);
  });

  it('反向 fixture：命令回退 deep import 或 composition root 漏注入会被检出', () => {
    expect(importSpecifiers("import { loadGlobalConfig } from '../../assembly/config/config-load.js';"))
      .toContain('../../assembly/config/config-load.js');
    expect('auditQueryCommand({ fsFactory }, opts)').not.toMatch(/\{ fsFactory, rootConfig \}/);
  });
});

describe('phase 1324/1325: claw leaf 共享窄 deps 边界', () => {
  it('read/ls/health/status 零config-load、type-import共享deps、参数为ClawCommandDeps', () => {
    for (const file of [...CLAWSPACE_COMMANDS, ...CLAW_INSPECTION_COMMANDS]) {
      const text = read(path.join(CLI_ROOT, 'commands', file));
      expect(importSpecifiers(text).filter((s) => s.endsWith('assembly/config/config-load.js'))).toEqual([]);
      expect(importSpecifiers(text)).toContain('./claw-command-deps.js');
      expect(text).toMatch(/deps:\s*ClawCommandDeps/);
    }
  });

  it('反向 fixture：leaf deep import 回流 / 退回只传 fsFactory 必须被检出', () => {
    expect(importSpecifiers("import { clawExists } from '../../assembly/config/config-load.js';"))
      .toContain('../../assembly/config/config-load.js');
    expect('lsCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, ...)')
      .not.toMatch(/deps:\s*ClawCommandDeps/);
  });
});
