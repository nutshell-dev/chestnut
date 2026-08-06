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

export function createSubagentCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Command {
  const cmd = new Command('subagent')
    .description('Subagent log observability commands');

  function action<TArgs extends unknown[]>(
    policy: SupervisionPolicy,
    handler: (...args: TArgs) => Promise<void>,
  ): (...args: TArgs) => Promise<void> {
    return cliAction(policy, handler, { fsFactory: deps.fsFactory });
  }

  cmd
    .command('list')
    .description('List subagent tasks')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .option('--status <status>', `Filter by status (${SUBAGENT_STATUS_VALUES.join('|')})`)
    .option('--kind <kind>', `Filter by kind (${SUBAGENT_KIND_VALUES.join('|')})`)
    .option('--contract <id>', 'Filter by contractId')
    .option('--limit <n>', 'Max rows (default: 20)')
    .option('--from <ts>', 'Filter started_at >= ts')
    .option('--to <ts>', 'Filter started_at <= ts')
    .option('--json', 'Output as JSON (machine-readable)')
    .action(action('observe_only', async (opts) => {
      await subagentListCommand(deps, opts);
    }));

  cmd
    .command('steps <id>')
    .description('Show subagent turn steps')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .option('--json', 'Output as JSON (machine-readable)')
    .option('--no-hint', 'Suppress step <n> usage hint')
    .action(action('observe_only', async (id: string, opts: { claw: string; json?: boolean; hint?: boolean }) => {
      await subagentStepsCommand(deps, id, opts.claw, { json: opts.json, noHint: opts.hint === false });
    }));

  cmd
    .command('step <n> <id>')
    .description('Show full detail of a single turn (n = "N" for whole turn, "N.x" for slot x)')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .option('--json', 'Output as JSON (machine-readable)')
    .action(action('observe_only', async (n: string, id: string, opts: { claw: string; json?: boolean }) => {
      await subagentStepCommand(deps, n, id, opts.claw, { json: opts.json });
    }));

  return cmd;
}
