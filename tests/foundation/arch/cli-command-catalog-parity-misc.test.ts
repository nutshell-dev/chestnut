/**
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: skill/watchdog/audit 命令族（3a） catalog parity。
 *
 * 单源守卫：catalog 声明 → cli 注册点投影（shapeCommand/applyCommandOptions）；
 * 反向防漂移：注册点残留裸 option 字面 ⊆ catalog（runtimeLiteral 白名单）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MISC_COMMAND_CATALOG,
  getMiscCommandSpec,
} from '../../../src/cli-protocol/index.js';

describe('phase 1874 Step L: skill/watchdog/audit 族 catalog parity（族 3a）', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/index.ts'), 'utf8');

  it('catalog 单源：族 id 全集 + runtimeLiteral 标记（audit --file/--col）', () => {
    expect(MISC_COMMAND_CATALOG.map((spec) => spec.id)).toEqual([
      'skill/install', 'skill/list',
      'skill/edit/begin', 'skill/edit/submit', 'skill/edit/retry', 'skill/edit/status', 'skill/history',
      'watchdog/start', 'watchdog/stop', 'audit/query', 'audit/lookup', 'audit/info',
    ]);
    const queryFlags = (getMiscCommandSpec('audit/query')!.options ?? []);
    expect(queryFlags.find((o) => o.flag === '--file <name>')!.runtimeLiteral).toBe(true);
    expect(queryFlags.find((o) => o.flag === '--col <key=val>')!.runtimeLiteral).toBe(true);
    expect(queryFlags.filter((o) => o.required).map((o) => o.flag)).toEqual(['-c, --claw <id>']);
    // Phase 1919 Step D：edit begin 的 --reason 为 catalog 声明的必填项（无理由不造依据）
    const beginFlags = (getMiscCommandSpec('skill/edit/begin')!.options ?? []);
    expect(beginFlags.filter((o) => o.required).map((o) => o.flag)).toEqual(['--reason <text>']);
  });

  it('注册点经 miscShape 投影（含 audit literal 就地注册保序）', () => {
    for (const anchor of [
      "miscShape(skillCmd.command('install [source]'), 'skill/install')",
      "miscShape(skillCmd.command('list'), 'skill/list')",
      // Phase 1919 Step D：skill edit 子族 + skill history
      "miscShape(skillEditCmd.command('begin <name>'), 'skill/edit/begin')",
      "miscShape(skillEditCmd.command('submit <editId>'), 'skill/edit/submit')",
      "miscShape(skillEditCmd.command('retry <editId>'), 'skill/edit/retry')",
      "miscShape(skillEditCmd.command('status <editId>'), 'skill/edit/status')",
      "miscShape(skillCmd.command('history <name>'), 'skill/history')",
      "miscShape(watchdogCmd.command('start'), 'watchdog/start')",
      "miscShape(watchdogCmd.command('stop'), 'watchdog/stop')",
      "miscShape(auditCmd.command('query'), 'audit/query', {",
      "miscShape(auditCmd.command('lookup'), 'audit/lookup')",
      "miscShape(auditCmd.command('info'), 'audit/info')",
    ]) {
      expect(indexSource).toContain(anchor);
    }
    // audit 段裸字面仅 runtimeLiteral 白名单（--file / --col）
    // Step H (phase1895) Step G: lookup 的 --file 注册已删（静默忽略退役）——
    // 剩余 --file 仅 query 一处。
    const section = indexSource.slice(indexSource.indexOf('const auditCmd = program'), indexSource.indexOf("auditCmd.on('command:*'"));
    const literals = [...section.matchAll(/\.(?:option|requiredOption)\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(literals.sort()).toEqual(['--col <key=val>', '--file <name>']);
  });
});
