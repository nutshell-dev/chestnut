/**
 * Phase 1798: CLI command catalog ↔ router/help parity（cli-protocol-command-catalog-drift）。
 *
 * - catalog 单源：list/steps/trace 的 option 集合（含 phase 1798 收敛的 --summary/--no-hint）；
 * - router 三处 verb 经 `applyClawCommandOptions` 投影、无私有 option 裸字面；
 * - 反向防漂移：claw-router.ts 残留裸 option 字面（未迁移 verb）必须存在于 catalog
 *   某个 spec 的 options（router→catalog 方向守卫）；
 * - help 消费同一 catalog：per-verb help 含收敛后的 option 行。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLAW_COMMAND_CATALOG,
  getClawCommandSpec,
  getMotionCommandSpec,
  getContractCommandSpec,
  CONTRACT_COMMAND_CATALOG,
  MOTION_COMMAND_CATALOG,
  renderClawCommandHelp,
} from '../../../src/cli-protocol/index.js';

const routerPath = path.join(process.cwd(), 'src/cli/commands/claw-router.ts');
const routerSource = fs.readFileSync(routerPath, 'utf8');

/** spec options 的 flag 集合（取完整 flag 字面，如 `--limit <n>`）。 */
function specFlags(id: string): string[] {
  return (getClawCommandSpec(id)?.options ?? []).map((o) => o.flag);
}

describe('cli command catalog parity (phase 1798)', () => {
  it('catalog 单源：list 含 --json/--summary，steps 含 --no-hint，trace 含 --contract(required)/--step/--no-hint', () => {
    expect(specFlags('list')).toEqual(['--json', '--summary']);
    expect(specFlags('steps')).toEqual(['--no-hint']);
    expect(specFlags('trace')).toEqual(['--contract <contractId>', '--step <n>', '--no-hint']);
    const contractOpt = getClawCommandSpec('trace')!.options![0]!;
    expect(contractOpt.required).toBe(true);
  });

  it('router list/steps/trace 经 applyClawCommandOptions 投影、无对应私有裸字面', () => {
    const projections = routerSource.match(/applyClawCommandOptions\(parser, '(list|steps|trace)'\)/g) ?? [];
    expect([...projections].sort()).toEqual([
      "applyClawCommandOptions(parser, 'list')",
      "applyClawCommandOptions(parser, 'steps')",
      "applyClawCommandOptions(parser, 'trace')",
    ]);
    for (const forbidden of ["'--summary'", "'--no-hint'", "'--contract <contractId>'", "'--step <n>'"]) {
      expect(routerSource).not.toContain(`parser.option(${forbidden}`);
      expect(routerSource).not.toContain(`parser.requiredOption(${forbidden}`);
    }
  });

  it('反向防漂移：router 残留裸 option 字面必须存在于 catalog 某个 spec', () => {
    const catalogFlags = new Set(
      CLAW_COMMAND_CATALOG.flatMap((spec) => (spec.options ?? []).map((o) => o.flag)),
    );
    const literals = [
      ...routerSource.matchAll(/parser\.(?:requiredOption|option)\(\s*'([^']+)'/g),
    ].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(0); // scanner 自证：仍能识别裸字面
    for (const flag of literals) {
      expect(catalogFlags.has(flag), `router 裸字面 ${flag} 不在 catalog`).toBe(true);
    }
  });

  it('help 消费同一 catalog：per-verb help 含收敛后的 option 行', () => {
    expect(renderClawCommandHelp('list')).toContain('--summary');
    expect(renderClawCommandHelp('steps')).toContain('--no-hint');
    const traceHelp = renderClawCommandHelp('trace')!;
    expect(traceHelp).toContain('--contract <contractId>');
    expect(traceHelp).toContain('--no-hint');
  });
});

describe('phase 1874 Step L: motion 族 catalog parity', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/index.ts'), 'utf8');

  it('catalog 单源：steps 含 --no-hint；outbox --limit 为 runtimeLiteral（注册点字面）', () => {
    expect((getMotionCommandSpec('steps')?.options ?? []).map((o) => o.flag)).toEqual(['--no-hint']);
    const limit = getMotionCommandSpec('outbox')!.options![0]!;
    expect(limit.flag).toBe('--limit <n>');
    expect(limit.runtimeLiteral).toBe(true);
    expect(MOTION_COMMAND_CATALOG.map((spec) => spec.id)).toEqual([
      'init', 'chat', 'stop', 'outbox', 'steps', 'step', 'daemon',
    ]);
  });

  it('七个 verb 经 motionShape 投影；motion 段仅 --limit 白名单字面', () => {
    const pairs: Array<[string, string]> = [
      ['init', 'init'], ['chat', 'chat'], ['stop', 'stop'], ['outbox', 'outbox'],
      ['steps', 'steps'], ['step <n>', 'step'], ['daemon', 'daemon'],
    ];
    for (const [cmd, id] of pairs) {
      expect(indexSource).toContain(`motionShape(motionCmd.command('${cmd}'), '${id}')`);
    }
    const motionSection = indexSource.slice(
      indexSource.indexOf('const motionCmd = program'),
      indexSource.indexOf("motionCmd.on('command:*'"),
    );
    const literals = [...motionSection.matchAll(/\.(?:option|requiredOption)\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(literals).toEqual(['--limit <n>']); // 白名单：仅 runtimeLiteral 项
  });

  it('runtimeLiteral 展示字面与 owner 常量一致（单源守卫）', () => {
    const owner = fs.readFileSync(path.join(process.cwd(), 'src/cli/commands/motion.ts'), 'utf8');
    const m = owner.match(/export const DEFAULT_OUTBOX_DRAIN_LIMIT = (\d+);/);
    expect(m).not.toBeNull();
    expect(getMotionCommandSpec('outbox')!.options![0]!.defaultValue).toBe(m![1]!);
  });
});

describe('phase 1874 Step L: contract 族 catalog parity', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/index.ts'), 'utf8');

  it('catalog 单源：四 verb + required 标记（--claw/--reason/--since）', () => {
    expect(CONTRACT_COMMAND_CATALOG.map((spec) => spec.id)).toEqual(['create', 'show', 'cancel', 'events']);
    const flags = (id: string) => (getContractCommandSpec(id)?.options ?? []).map((o) => o.flag);
    expect(flags('create')).toEqual(['-c, --claw <id>', '--file <path>', '--dir <path>']);
    expect(flags('cancel')).toEqual(['-c, --claw <id>', '--reason <text>', '--contract <id>']);
    expect(getContractCommandSpec('cancel')!.options!.filter((o) => o.required).map((o) => o.flag))
      .toEqual(['-c, --claw <id>', '--reason <text>']);
    expect(flags('events')).toEqual(['--since <timestamp>']);
    expect(getContractCommandSpec('events')!.options![0]!.required).toBe(true);
  });

  it('四 verb 经 contractShape 投影；contract 段零裸 option 字面', () => {
    const pairs: Array<[string, string]> = [
      ['create', 'create'], ['show', 'show'], ['cancel', 'cancel'], ['events <claw>', 'events'],
    ];
    for (const [cmd, id] of pairs) {
      expect(indexSource).toContain(`contractShape(contractCmd.command('${cmd}'), '${id}')`);
    }
    const section = indexSource.slice(
      indexSource.indexOf('const contractCmd = program'),
      indexSource.indexOf("contractCmd.on('command:*'"),
    );
    const literals = [...section.matchAll(/\.(?:option|requiredOption)\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(literals).toEqual([]);
  });
});
