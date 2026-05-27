/**
 * @module L6.CLI.Subagent
 * Subagent log observability CLI commands
 */

import { Command } from 'commander';
import { subagentListCommand } from './subagent-list.js';
import { subagentStepsCommand, subagentStepCommand } from './subagent-steps.js';
import { makeClawId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export function createSubagentCommand(deps: { fsFactory: (baseDir: string) => FileSystem }): Command {
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
    .option('--json', 'Output as JSON (machine-readable)')
    .action(async (opts) => {
      await subagentListCommand(deps, opts);
    });

  cmd
    .command('steps <id>')
    .description('Show subagent turn steps')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .option('--json', 'Output as JSON (machine-readable)')
    .action(async (id: string, opts: { claw: string; json?: boolean }) => {
      await subagentStepsCommand(deps, id, makeClawId(opts.claw), { json: opts.json });
    });

  cmd
    .command('step <n> <id>')
    .description('Show full detail of a single turn (n = "N" for whole turn, "N.x" for slot x)')
    .requiredOption('-c, --claw <claw>', 'Claw to query')
    .option('--json', 'Output as JSON (machine-readable)')
    .action(async (n: string, id: string, opts: { claw: string; json?: boolean }) => {
      await subagentStepCommand(deps, n, id, makeClawId(opts.claw), { json: opts.json });
    });

  return cmd;
}
