/**
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: contract 命令族 catalog parity。
 *
 * 单源守卫：catalog 声明 → cli 注册点投影（shapeCommand/applyCommandOptions）；
 * 反向防漂移：注册点残留裸 option 字面 ⊆ catalog（runtimeLiteral 白名单）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTRACT_COMMAND_CATALOG,
  getContractCommandSpec,
} from '../../../src/cli-protocol/index.js';

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
