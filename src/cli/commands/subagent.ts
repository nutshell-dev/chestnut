/**
 * @module L6.CLI.Subagent
 * Subagent log observability CLI commands
 */

import { Command } from 'commander';
import { subagentListCommand } from './subagent-list.js';
import { subagentStepsCommand, subagentStepCommand } from './subagent-steps.js';

export function createSubagentCommand(): Command {
  const cmd = new Command('subagent')
    .description('Subagent log observability commands');

  cmd
    .command('list')
    .description('List subagent tasks')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .option('--status <status>', 'Filter by status (completed|running|failed)')
    .option('--kind <kind>', 'Filter by kind (dispatch|spawn|verifier|random_dream|cron)')
    .option('--contract <id>', 'Filter by contractId')
    .option('--limit <n>', 'Max rows (default: 20)')
    .option('--from <ts>', 'Filter started_at >= ts')
    .option('--to <ts>', 'Filter started_at <= ts')
    .action(async (opts) => {
      await subagentListCommand(opts);
    });

  cmd
    .command('steps <id>')
    .description('Show subagent turn steps')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .action(async (id: string, opts: { claw: string }) => {
      await subagentStepsCommand(id, opts.claw);
    });

  cmd
    .command('step <n> <id>')
    .description('Show full detail of a single turn')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .action(async (n: string, id: string, opts: { claw: string }) => {
      await subagentStepCommand(parseInt(n, 10), id, opts.claw);
    });

  return cmd;
}
