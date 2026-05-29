/**
 * Clawforum CLI - Command line interface
 */

// 设置工作区根路径，供 exec 子进程继承（子进程 CWD 是 clawDir，但不一定在 .clawforum 下）
if (!process.env.CLAWFORUM_ROOT) {
  process.env.CLAWFORUM_ROOT = process.cwd();
}

import { program } from 'commander';
import { CliError } from './errors.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';
// `initCommand` and `startCommand` are lazy-loaded inside their action handlers
// (phase 1379): these modules transitively pull in llm-orchestrator + core/contract
// + foundation/tools (combined ~10s vitest cold load), forcing every CLI subcommand
// (e.g. `claw daemon`) to pay that cost. Lazy imports defer the cost to the user
// who actually runs `start` or `init`.
import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import type { FileSystem } from '../foundation/fs/types.js';
import { 
  createCommand, 
  chatCommand, 
  stopCommand, 
  listCommand, 
  healthCommand,
  sendCommand,
  outboxCommand,
  cpCommand,
  readCommand,
} from './commands/claw.js';

import { 
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
  stopCommand as motionStopCommand,
} from './commands/motion.js';
import { contractCreateCommand, contractCreateFromDirCommand, contractLogCommand, contractEventsCommand } from './commands/contract.js';
import { skillInstallUserCommand, skillInstallClawCommand } from './commands/skill.js';
import { runWatchdogLoop, startCommand as watchdogStart, stopCommand as watchdogStop } from '../watchdog/watchdog.js';
import { createConfigCommand } from './commands/config.js';
import { stopAllCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { createSubagentCommand } from './commands/subagent.js';
import { clawStepsCommand, clawStepCommand } from './commands/claw-steps.js';
import { motionStepsCommand, motionStepCommand } from './commands/motion-steps.js';
import { createDirContext } from '../foundation/audit/index.js';
import { getClawforumRoot, getClawDir, loadGlobalConfig } from '../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../assembly/index.js';
import { parseIntOption } from './parse-int-option.js';
import { makeClawId } from '../foundation/identity/index.js';
import { makeContractId } from '../foundation/identity/index.js';

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

program
  .name('clawforum')
  .description('AI Agent Orchestration System')
  .version('0.1.0');

// config command
program.addCommand(createConfigCommand({ fsFactory }));

// stop command
program
  .command('stop')
  .description('Stop all clawforum processes (watchdog → motion → claws)')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext({ fsFactory }, getClawforumRoot());
    await stopAllCommand({ fsFactory }, { audit });
  }));

// status command
program
  .command('status')
  .description('Show status of all clawforum processes')
  .action(withCliErrorHandling(async () => {
    await statusCommand({ fsFactory });
  }));

// start command
program
  .command('start')
  .description('Start the system (initializes if needed) and open Motion chat')
  .action(withCliErrorHandling(async () => {
    const { startCommand } = await import('./commands/start.js');
    const { audit } = createDirContext({ fsFactory }, getClawforumRoot());
    await startCommand({ fsFactory }, { audit });
  }));

// init command
program
  .command('init')
  .description('Initialize clawforum workspace')
  .action(withCliErrorHandling(async () => {
    const { initCommand } = await import('./commands/init.js');
    const { audit } = createDirContext({ fsFactory }, getClawforumRoot());
    await initCommand({ fsFactory }, false, { audit });
  }));

// claw command group
const clawCmd = program
  .command('claw')
  .description('Manage Claws');

// claw create
clawCmd
  .command('create <name>')
  .description('Create a new Claw')
  .action(withCliErrorHandling(async (name: string) => {
    loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    const { audit } = createDirContext({ fsFactory }, getClawDir(name));
    await createCommand({ fsFactory }, name, { audit });
  }));

// claw chat
clawCmd
  .command('chat <name>')
  .description('Chat with a Claw')
  .action(withCliErrorHandling(async (name: string) => {
    await chatCommand({ fsFactory }, name);
  }));

// claw stop
clawCmd
  .command('stop <name>')
  .description('Stop Claw daemon')
  .action(withCliErrorHandling(async (name: string) => {
    loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    const { audit } = createDirContext({ fsFactory }, getClawDir(name));
    await stopCommand({ fsFactory }, name, { audit });
  }));

// claw list
clawCmd
  .command('list')
  .description('List all Claws and their status')
  .option('--json', 'Output as JSON (machine-readable)')
  .action(withCliErrorHandling(async (opts: { json?: boolean }) => {
    await listCommand({ fsFactory }, opts);
  }));

// claw health
clawCmd
  .command('health <name>')
  .description('Show Claw health status')
  .option('--json', 'Output as JSON (machine-readable)')
  .action(withCliErrorHandling(async (name: string, opts: { json?: boolean }) => {
    await healthCommand({ fsFactory }, name, opts);
  }));

// claw send
clawCmd
  .command('send <name> <message>')
  .description('Send a message to a Claw inbox')
  .option('--priority <level>', 'Message priority (critical/high/normal/low)', 'normal')
  .action(withCliErrorHandling(async (name: string, message: string, opts: { priority: string }) => {
    // 验证 priority 值
    const validPriorities = ['critical', 'high', 'normal', 'low'];
    if (!validPriorities.includes(opts.priority)) {
      throw new CliError(`Invalid priority: ${opts.priority}. Must be one of: ${validPriorities.join(', ')}`);
    }
    await sendCommand({ fsFactory }, name, message, { priority: opts.priority as 'critical' | 'high' | 'normal' | 'low' });
  }));

// claw outbox
clawCmd
  .command('outbox <name>')
  .description('Read and consume outbox messages from a Claw')
  .option('--limit <n>', 'Max messages to read (default: 1)', '1')
  .action(withCliErrorHandling(async (name: string, opts: { limit: string }) => {
    loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    const { audit } = createDirContext({ fsFactory }, getClawDir(name));
    const limit = parseIntOption(opts.limit, '--limit must be a non-negative integer');
    await outboxCommand({ fsFactory }, name, { limit }, { audit });
  }));

// claw cp
clawCmd
  .command('cp <source> <name>')
  .description('Copy a local file/directory into a Claw\'s clawspace')
  .option('-t, --target <subdir>', 'Target subdirectory under clawspace')
  .action(withCliErrorHandling(async (source: string, name: string, opts: { target?: string }) => {
    await cpCommand({ fsFactory }, source, name, opts.target);
  }));

// claw read
clawCmd
  .command('read <name> <path>')
  .description('Read a file from a Claw\'s clawspace')
  .option('--offset <n>', 'Starting line (1-indexed, negative counts from end)', parseInt)
  .option('--limit <n>', 'Max lines to read', parseInt)
  .action(withCliErrorHandling(async (name: string, filePath: string, opts: { offset?: number; limit?: number }) => {
    await readCommand({ fsFactory }, name, filePath, opts);
  }));

// claw trace
clawCmd
  .command('trace')
  .description('Show claw execution trace for a contract')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .requiredOption('--contract <contractId>', 'Contract ID')
  .option('--step <n>', 'Show full content of step N (no truncation)', parseInt)
  .action(withCliErrorHandling(async (opts: { claw: string; contract: string; step?: number }) => {
    const { clawTraceCommand } = await import('./commands/claw.js');
    await clawTraceCommand({ fsFactory }, makeClawId(opts.claw), makeContractId(opts.contract), opts.step);
  }));

// claw steps
clawCmd
  .command('steps <name>')
  .description('Show main agent turn steps (name = "motion" or claw name)')
  .action(withCliErrorHandling(async (name: string) => {
    await clawStepsCommand({ fsFactory }, name);
  }));

// claw step
clawCmd
  .command('step <n> <name>')
  .description('Show full detail of a single turn (n = "N" for whole turn, "N.x" for slot x)')
  .action(withCliErrorHandling(async (n: string, name: string) => {
    await clawStepCommand({ fsFactory }, n, name);
  }));

// claw daemon (auto-backgrounds)
clawCmd
  .command('daemon <name>')
  .description('Start Claw daemon (auto-backgrounds)')
  .action(withCliErrorHandling(async (name: string) => {
    const { clawDaemonCommand } = await import('./commands/claw-daemon.js');
    await clawDaemonCommand({ fsFactory }, name);
  }));

clawCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of clawCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// motion command group
const motionCmd = program
  .command('motion')
  .description('Manage Motion (system orchestrator)');

// motion init
motionCmd
  .command('init')
  .description('Initialize Motion configuration')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext({ fsFactory }, getClawforumRoot());
    await motionInitCommand({ fsFactory }, false, { audit });
  }));

// motion chat
motionCmd
  .command('chat')
  .description('Chat with Motion')
  .action(withCliErrorHandling(async () => {
    await motionChatCommand({ fsFactory });
  }));

// motion stop
motionCmd
  .command('stop')
  .description('Stop Motion daemon')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext({ fsFactory }, getClawforumRoot());
    await motionStopCommand({ fsFactory }, { audit });
  }));

// motion steps
motionCmd
  .command('steps')
  .description('Show motion turn steps')
  .action(withCliErrorHandling(async () => {
    await motionStepsCommand({ fsFactory });
  }));

// motion step
motionCmd
  .command('step <n>')
  .description('Show full detail of a single motion turn')
  .action(withCliErrorHandling(async (n: string) => {
    await motionStepCommand({ fsFactory }, n);
  }));

// motion daemon (auto-backgrounds)
motionCmd
  .command('daemon')
  .description('Start Motion daemon (auto-backgrounds)')
  .action(withCliErrorHandling(async () => {
    const { motionDaemonCommand } = await import('./commands/motion-daemon.js');
    await motionDaemonCommand({ fsFactory });
  }));

motionCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of motionCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// contract command group
const contractCmd = program
  .command('contract')
  .description('Manage contracts');

// contract create
contractCmd
  .command('create')
  .description('Create a contract (--file: import YAML, --dir: directory with contract.yaml + verification/)')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--file <path>', 'Path to contract YAML file')
  .option('--dir <path>', 'Directory containing contract.yaml and verification/ folder')
  .action(withCliErrorHandling(async (opts: { claw: string; file?: string; dir?: string }) => {
    loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
    const { audit } = createDirContext({ fsFactory }, getClawDir(opts.claw));
    if (opts.file && opts.dir) {
      throw new CliError('--file and --dir are mutually exclusive. Use one of --file or --dir, not both.');
    } else if (opts.file) {
      await contractCreateCommand({ fsFactory }, makeClawId(opts.claw), opts.file, { audit });
    } else if (opts.dir) {
      await contractCreateFromDirCommand({ fsFactory }, makeClawId(opts.claw), opts.dir, { audit });
    } else {
      throw new CliError('must provide --file or --dir');
    }
  }));

contractCmd
  .command('log')
  .description('Show contract execution log for a claw')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--contract <id>', 'Contract ID (default: active contract)')
  .action(withCliErrorHandling(async (opts: { claw: string; contract?: string }) => {
    await contractLogCommand({ fsFactory }, makeClawId(opts.claw), opts.contract);
  }));

contractCmd
  .command('events <claw>')
  .description('Show contract events since a timestamp')
  .requiredOption('--since <timestamp>', 'Unix timestamp in milliseconds')
  .action(withCliErrorHandling(async (claw: string, opts: { since: string }) => {
    const since = parseIntOption(opts.since, '--since must be a Unix timestamp in milliseconds');
    await contractEventsCommand({ fsFactory }, makeClawId(claw), since);
  }));

contractCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of contractCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// skill command group
const skillCmd = program
  .command('skill')
  .description('Manage skills');

skillCmd
  .command('install [source]')
  .description('Install a skill from local path, or install dispatch-skill to a claw (--claw)')
  .option('-c, --claw <id>', 'Target claw ID (internal mode: install from dispatch-skills to claw)')
  .option('--skill <name>', 'Skill name (required with --claw)')
  .action(withCliErrorHandling(async (source: string | undefined, opts: { claw?: string; skill?: string }) => {
    if (opts.claw) {
      if (!opts.skill) {
        throw new CliError('--skill <name> is required with --claw');
      }
      loadGlobalConfig({ fsFactory }, CONFIG_DEFAULTS);
      const { audit } = createDirContext({ fsFactory }, getClawDir(opts.claw));
      await skillInstallClawCommand({ fsFactory }, makeClawId(opts.claw), opts.skill, { audit });
    } else {
      if (!source) {
        throw new CliError('source path is required');
      }
      const { audit } = createDirContext({ fsFactory }, getClawforumRoot());
      await skillInstallUserCommand({ fsFactory }, source, { audit });
    }
  }));

skillCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of skillCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// watchdog command group
const watchdogCmd = program
  .command('watchdog')
  .description('System watchdog for Motion');

// watchdog start
watchdogCmd
  .command('start')
  .description('Start watchdog')
  .action(withCliErrorHandling(async () => {
    await watchdogStart(fsFactory);
  }));

// watchdog stop
watchdogCmd
  .command('stop')
  .description('Stop watchdog')
  .action(withCliErrorHandling(async () => {
    await watchdogStop(fsFactory);
  }));

// watchdog daemon (internal command, spawned by startCommand)
watchdogCmd
  .command('daemon')
  .description('Run watchdog daemon (internal)')
  .action(withCliErrorHandling(async () => {
    await runWatchdogLoop(fsFactory);
  }));

watchdogCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of watchdogCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// subagent command group
program.addCommand(createSubagentCommand({ fsFactory }));

program.parse();
