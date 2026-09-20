/**
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: motion 命令族 catalog parity。
 *
 * 单源守卫：catalog 声明 → cli 注册点投影（shapeCommand/applyCommandOptions）；
 * 反向防漂移：注册点残留裸 option 字面 ⊆ catalog（runtimeLiteral 白名单）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MOTION_COMMAND_CATALOG,
  getMotionCommandSpec,
} from '../../../src/cli-protocol/index.js';

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
