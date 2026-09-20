/**
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: subagent/config 命令族（3b） catalog parity。
 *
 * 单源守卫：catalog 声明 → cli 注册点投影（shapeCommand/applyCommandOptions）；
 * 反向防漂移：注册点残留裸 option 字面 ⊆ catalog（runtimeLiteral 白名单）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SUBAGENT_COMMAND_CATALOG,
  getSubagentCommandSpec,
  CONFIG_COMMAND_CATALOG,
  getConfigCommandSpec,
} from '../../../src/cli-protocol/index.js';

describe('phase 1874 Step L: subagent/config 族 catalog parity（族 3b）', () => {
  const saSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/commands/subagent.ts'), 'utf8');
  const cfgSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/commands/config.ts'), 'utf8');

  it('subagent：catalog id 全集 + 动态 desc 两项 runtimeLiteral', () => {
    expect(SUBAGENT_COMMAND_CATALOG.map((sp) => sp.id)).toEqual(['subagent', 'subagent/list', 'subagent/steps', 'subagent/step']);
    const opts = getSubagentCommandSpec('subagent/list')!.options!;
    expect(opts.find((o) => o.flag === '--status <status>')!.runtimeLiteral).toBe(true);
    expect(opts.find((o) => o.flag === '--kind <kind>')!.runtimeLiteral).toBe(true);
    expect(opts.find((o) => o.flag === '-c, --claw <claw>')!.required).toBe(true);
  });

  it('subagent 构建器经 shapeCommand 投影；动态 desc 就地注册、无其它裸字面', () => {
    expect(saSource).toContain("shapeCommand(new Command('subagent'), spec('subagent'))");
    for (const anchor of [
      "shapeCommand(cmd.command('list'), spec('subagent/list'), {",
      "shapeCommand(cmd.command('steps <id>'), spec('subagent/steps'))",
      "shapeCommand(cmd.command('step <n> <id>'), spec('subagent/step'))",
    ]) expect(saSource).toContain(anchor);
    const literals = [...saSource.matchAll(/\.(?:option|requiredOption)\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(literals.sort()).toEqual(['--kind <kind>', '--status <status>']); // 白名单：动态 desc 两项
  });

  it('config：catalog id 全集 + 构建器经 shapeCommand 投影、零裸 option 字面', () => {
    expect(CONFIG_COMMAND_CATALOG.map((sp) => sp.id)).toEqual([
      'config', 'config/provider', 'config/provider/add', 'config/provider/list',
      'config/provider/remove', 'config/provider/set-primary', 'config/provider/move',
    ]);
    for (const anchor of [
      "shapeCommand(new Command('config'), configSpec('config'))",
      "shapeCommand(new Command('provider'), configSpec('config/provider'))",
      "shapeCommand(providerCmd.command('add'), configSpec('config/provider/add'))",
      "shapeCommand(providerCmd.command('list'), configSpec('config/provider/list'))",
      "shapeCommand(providerCmd.command('remove <label>'), configSpec('config/provider/remove'))",
      "shapeCommand(providerCmd.command('set-primary <label>'), configSpec('config/provider/set-primary'))",
      "shapeCommand(providerCmd.command('move <label> <position>'), configSpec('config/provider/move'))",
    ]) expect(cfgSource).toContain(anchor);
    expect(cfgSource).not.toMatch(/\.(?:option|requiredOption)\(/);
  });
});
