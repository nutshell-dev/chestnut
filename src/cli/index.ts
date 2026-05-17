/**
 * Clawforum CLI - Command line interface
 */

// 设置工作区根路径，供 exec 子进程继承（子进程 CWD 是 clawDir，但不一定在 .clawforum 下）
if (!process.env.CLAWFORUM_ROOT) {
  process.env.CLAWFORUM_ROOT = process.cwd();
}

import { program } from 'commander';
import { handleCliError, CliError } from './errors.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import * as path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { 
  createCommand, 
  chatCommand, 
  stopCommand, 
  listCommand, 
  healthCommand,
  sendCommand,
  outboxCommand,
} from './commands/claw.js';

import { 
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
  stopCommand as motionStopCommand,
} from './commands/motion.js';
import { contractCreateCommand, contractCreateFromDirCommand, contractLogCommand, contractEventsCommand } from './commands/contract.js';
import { skillInstallUserCommand, skillInstallClawCommand } from './commands/skill.js';
import { runWatchdogLoop, startCommand as watchdogStart, stopCommand as watchdogStop } from '../watchdog/watchdog.js';
import { configCommand } from './commands/config.js';
import { stopAllCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { createSubagentCommand } from './commands/subagent.js';
import { clawStepsCommand, clawStepCommand } from './commands/claw-steps.js';
import { motionStepsCommand, motionStepCommand } from './commands/motion-steps.js';
import { LOGS_DIR } from '../types/paths.js';
import { createDirContext } from './utils/factories.js';
import { getClawforumRoot, getClawDir, loadGlobalConfig } from '../foundation/config/index.js';
import { getWorkspaceRoot } from '../foundation/config/paths.js';
import { parseIntOption } from './parse-int-option.js';

program
  .name('clawforum')
  .description('AI Agent Orchestration System')
  .version('0.1.0');

// config command
program.addCommand(configCommand);

// stop command
program
  .command('stop')
  .description('Stop all clawforum processes (watchdog → motion → claws)')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext(getClawforumRoot());
    await stopAllCommand({ audit });
  }));

// status command
program
  .command('status')
  .description('Show status of all clawforum processes')
  .action(withCliErrorHandling(async () => {
    await statusCommand();
  }));

// start command
program
  .command('start')
  .description('Start the system (initializes if needed) and open Motion chat')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext(getClawforumRoot());
    await startCommand({ audit });
  }));

// init command
program
  .command('init')
  .description('Initialize clawforum workspace')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext(getClawforumRoot());
    await initCommand(false, { audit });
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
    loadGlobalConfig();
    const { audit } = createDirContext(getClawDir(name));
    await createCommand(name, { audit });
  }));

// claw chat
clawCmd
  .command('chat <name>')
  .description('Chat with a Claw')
  .action(withCliErrorHandling(async (name: string) => {
    await chatCommand(name);
  }));

// claw stop
clawCmd
  .command('stop <name>')
  .description('Stop Claw daemon')
  .action(withCliErrorHandling(async (name: string) => {
    loadGlobalConfig();
    const { audit } = createDirContext(getClawDir(name));
    await stopCommand(name, { audit });
  }));

// claw list
clawCmd
  .command('list')
  .description('List all Claws and their status')
  .option('--json', 'Output as JSON (machine-readable)')
  .action(withCliErrorHandling(async (opts: { json?: boolean }) => {
    await listCommand(opts);
  }));

// claw health
clawCmd
  .command('health <name>')
  .description('Show Claw health status')
  .option('--json', 'Output as JSON (machine-readable)')
  .action(withCliErrorHandling(async (name: string, opts: { json?: boolean }) => {
    await healthCommand(name, opts);
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
    await sendCommand(name, message, { priority: opts.priority as 'critical' | 'high' | 'normal' | 'low' });
  }));

// claw outbox
clawCmd
  .command('outbox <name>')
  .description('Read and consume outbox messages from a Claw')
  .option('--limit <n>', 'Max messages to read (default: 1)', '1')
  .action(withCliErrorHandling(async (name: string, opts: { limit: string }) => {
    loadGlobalConfig();
    const { audit } = createDirContext(getClawDir(name));
    const limit = parseIntOption(opts.limit, '--limit');
    await outboxCommand(name, { limit }, { audit });
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
    await clawTraceCommand(opts.claw, opts.contract, opts.step);
  }));

// claw steps
clawCmd
  .command('steps <name>')
  .description('Show main agent turn steps (name = "motion" or claw name)')
  .action(withCliErrorHandling(async (name: string) => {
    await clawStepsCommand(name);
  }));

// claw step
clawCmd
  .command('step <n> <name>')
  .description('Show full detail of a single turn (n = "N" for whole turn, "N.x" for slot x)')
  .action(withCliErrorHandling(async (n: string, name: string) => {
    await clawStepCommand(n, name);
  }));

// claw daemon (auto-backgrounds)
clawCmd
  .command('daemon <name>')
  .description('Start Claw daemon (auto-backgrounds)')
  .action(withCliErrorHandling(async (name: string) => {
    // 前台入口：后台启动
    const { loadGlobalConfig, clawExists, getClawDir, getGlobalConfigPath } = await import('../foundation/config/index.js');
    const { NodeFileSystem } = await import('../foundation/fs/node-fs.js');
    const { createSystemAudit } = await import('../foundation/audit/index.js');
    const { createAgentProcessManager } = await import('../foundation/process-manager/agent-factory.js');
    loadGlobalConfig();
    if (!clawExists(name)) {
      throw new CliError(`Claw "${name}" does not exist. Try \`clawforum claw list\` to see existing claws.`);
    }
    const clawDir = getClawDir(name);
    const baseDir = path.dirname(getGlobalConfigPath());
    const nodeFs = new NodeFileSystem({ baseDir });
    const systemAudit = createSystemAudit(nodeFs, baseDir);
    const pm = createAgentProcessManager(systemAudit);
    if (pm.isAlive(name)) {
      console.log(`Claw "${name}" is already running`);
      return;
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const bundleEntry = path.join(thisDir, 'daemon-entry.js');
    const daemonEntryPath = existsSync(bundleEntry) ? bundleEntry : path.resolve(thisDir, '..', 'daemon-entry.js');
    const pid = await pm.spawn(name, {
      command: 'node',
      args: [daemonEntryPath, name],
      logFile: path.join(clawDir, LOGS_DIR, 'daemon.log'),
      env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
    });
    console.log(`Started Claw "${name}" (PID: ${pid})`);
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
    const { audit } = createDirContext(getClawforumRoot());
    await motionInitCommand(false, { audit });
  }));

// motion chat
motionCmd
  .command('chat')
  .description('Chat with Motion')
  .action(withCliErrorHandling(async () => {
    await motionChatCommand();
  }));

// motion stop
motionCmd
  .command('stop')
  .description('Stop Motion daemon')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext(getClawforumRoot());
    await motionStopCommand({ audit });
  }));

// motion steps
motionCmd
  .command('steps')
  .description('Show motion turn steps')
  .action(async () => {
    try {
      await motionStepsCommand();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// motion step
motionCmd
  .command('step <n>')
  .description('Show full detail of a single motion turn')
  .action(async (n: string) => {
    try {
      await motionStepCommand(n);
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// motion daemon (auto-backgrounds)
motionCmd
  .command('daemon')
  .description('Start Motion daemon (auto-backgrounds)')
  .action(withCliErrorHandling(async () => {
    // 前台入口
    const { loadGlobalConfig, getMotionDir } = await import('../foundation/config/index.js');
    const { NodeFileSystem } = await import('../foundation/fs/node-fs.js');
    const { createSystemAudit } = await import('../foundation/audit/index.js');
    const { createAgentProcessManager } = await import('../foundation/process-manager/agent-factory.js');
    loadGlobalConfig();
    const motionDir = getMotionDir();
    const baseDir = path.dirname(motionDir);
    const nodeFs = new NodeFileSystem({ baseDir });
    const systemAudit = createSystemAudit(nodeFs, baseDir);
    const pm = createAgentProcessManager(systemAudit);
    if (pm.isAlive('motion')) {
      console.log('Motion is already running');
      return;
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const bundleEntry = path.join(thisDir, 'daemon-entry.js');
    const daemonEntryPath = existsSync(bundleEntry) ? bundleEntry : path.resolve(thisDir, '..', 'daemon-entry.js');
    const pid = await pm.spawn('motion', {
      command: 'node',
      args: [daemonEntryPath, 'motion'],
      logFile: path.join(motionDir, LOGS_DIR, 'daemon.log'),
      env: { ...process.env, CLAWFORUM_ROOT: getWorkspaceRoot() } as Record<string, string | undefined>,
    });
    console.log(`Started Motion daemon (PID: ${pid})`);
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
  .description('Create a contract (--file: import YAML, --dir: directory with contract.yaml + acceptance/)')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--file <path>', 'Path to contract YAML file')
  .option('--dir <path>', 'Directory containing contract.yaml and acceptance/ folder')
  .action(withCliErrorHandling(async (opts: { claw: string; file?: string; dir?: string }) => {
    loadGlobalConfig();
    const { audit } = createDirContext(getClawDir(opts.claw));
    if (opts.file && opts.dir) {
      throw new CliError('--file and --dir are mutually exclusive. Use one of --file or --dir, not both.');
    } else if (opts.file) {
      await contractCreateCommand(opts.claw, opts.file, { audit });
    } else if (opts.dir) {
      await contractCreateFromDirCommand(opts.claw, opts.dir, { audit });
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
    await contractLogCommand(opts.claw, opts.contract);
  }));

contractCmd
  .command('events <claw>')
  .description('Show contract events since a timestamp')
  .requiredOption('--since <timestamp>', 'Unix timestamp in milliseconds')
  .action(withCliErrorHandling(async (claw: string, opts: { since: string }) => {
    const since = parseIntOption(opts.since, '--since');
    await contractEventsCommand(claw, since);
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
      loadGlobalConfig();
      const { audit } = createDirContext(getClawDir(opts.claw));
      await skillInstallClawCommand(opts.claw, opts.skill, { audit });
    } else {
      if (!source) {
        throw new CliError('source path is required');
      }
      const { audit } = createDirContext(getClawforumRoot());
      await skillInstallUserCommand(source, { audit });
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
    await watchdogStart();
  }));

// watchdog stop
watchdogCmd
  .command('stop')
  .description('Stop watchdog')
  .action(withCliErrorHandling(async () => {
    await watchdogStop();
  }));

// watchdog daemon (internal command, spawned by startCommand)
watchdogCmd
  .command('daemon')
  .description('Run watchdog daemon (internal)')
  .action(withCliErrorHandling(async () => {
    await runWatchdogLoop();
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
program.addCommand(createSubagentCommand());

program.parse();
