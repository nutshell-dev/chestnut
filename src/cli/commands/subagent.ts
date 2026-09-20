/**
 * @module L6.CLI.Subagent
 * Subagent log observability CLI commands
 */

import { Command } from 'commander';
import { subagentListCommand } from './subagent-list.js';
import { subagentStepsCommand, subagentStepCommand } from './subagent-steps.js';
import { SUBAGENT_KIND_VALUES, SUBAGENT_STATUS_VALUES } from './subagent-helpers.js';
import { cliAction, type SupervisionPolicy } from '../supervision-policy.js';
import type { FileSystem } from '../../foundation/fs/index.js';
// phase 1874 Step L（族 3b）: 命令形状经 CLIProtocol catalog 投影
import { getSubagentCommandSpec, shapeCommand } from '../../cli-protocol/index.js';
import type { CommandShapeSpec } from '../../cli-protocol/index.js';

function spec(id: string): CommandShapeSpec {
  const s = getSubagentCommandSpec(id);
  if (!s) throw new Error(`unknown subagent command id in catalog: ${id}`);
  return s;
}

export function createSubagentCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Command {
  const cmd = shapeCommand(new Command('subagent'), spec('subagent'));

  function action<TArgs extends unknown[]>(
    policy: SupervisionPolicy,
    handler: (...args: TArgs) => Promise<void>,
  ): (...args: TArgs) => Promise<void> {
    return cliAction(policy, handler, { fsFactory: deps.fsFactory });
  }

  shapeCommand(cmd.command('list'), spec('subagent/list'), {
    // 动态 desc（枚举 owner 常量）——就地注册保序（1798 边界）
    '--status <status>': (c) => { c.option('--status <status>', `Filter by status (${SUBAGENT_STATUS_VALUES.join('|')})`); },
    '--kind <kind>': (c) => { c.option('--kind <kind>', `Filter by kind (${SUBAGENT_KIND_VALUES.join('|')})`); },
  })
    .action(action('observe_only', async (opts) => {
      await subagentListCommand(deps, opts);
    }));

  shapeCommand(cmd.command('steps <id>'), spec('subagent/steps'))
    .action(action('observe_only', async (id: string, opts: { claw: string; json?: boolean; hint?: boolean }) => {
      await subagentStepsCommand(deps, id, opts.claw, { json: opts.json, noHint: opts.hint === false });
    }));

  shapeCommand(cmd.command('step <n> <id>'), spec('subagent/step'))
    .action(action('observe_only', async (n: string, id: string, opts: { claw: string; json?: boolean }) => {
      await subagentStepCommand(deps, n, id, opts.claw, { json: opts.json });
    }));

  return cmd;
}
