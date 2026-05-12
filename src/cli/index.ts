/**
 * Clawforum CLI - Command line interface
 */

// 设置工作区根路径，供 exec 子进程继承（子进程 CWD 是 clawDir，但不一定在 .clawforum 下）
if (!process.env.CLAWFORUM_ROOT) {
  process.env.CLAWFORUM_ROOT = process.cwd();
}

import { program } from 'commander';
import { handleCliError, CliError } from './errors.js';
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
import { LOGS_DIR } from '../types/paths.js';
import { createDirContext } from './utils/factories.js';
import { getClawforumRoot, getClawDir, loadGlobalConfig } from '../foundation/config/index.js';
import { getWorkspaceRoot } from '../foundation/config/paths.js';



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
  .action(async () => {
    try {
      const { audit } = createDirContext(getClawforumRoot());
      await stopAllCommand({ audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// status command
program
  .command('status')
  .description('Show status of all clawforum processes')
  .action(async () => {
    try {
      await statusCommand();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// start command
program
  .command('start')
  .description('Start the system (initializes if needed) and open Motion chat')
  .action(async () => {
    try {
      const { audit } = createDirContext(getClawforumRoot());
      await startCommand({ audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// init command
program
  .command('init')
  .description('Initialize clawforum workspace')
  .action(async () => {
    try {
      const { audit } = createDirContext(getClawforumRoot());
      await initCommand(false, { audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw command group
const clawCmd = program
  .command('claw')
  .description('Manage Claws');

// claw create
clawCmd
  .command('create <name>')
  .description('Create a new Claw')
  .action(async (name: string) => {
    try {
      loadGlobalConfig();
      const { audit } = createDirContext(getClawDir(name));
      await createCommand(name, { audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw chat
clawCmd
  .command('chat <name>')
  .description('Chat with a Claw')
  .action(async (name: string) => {
    try {
      await chatCommand(name);
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw stop
clawCmd
  .command('stop <name>')
  .description('Stop Claw daemon')
  .action(async (name: string) => {
    try {
      loadGlobalConfig();
      const { audit } = createDirContext(getClawDir(name));
      await stopCommand(name, { audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw list
clawCmd
  .command('list')
  .description('List all Claws and their status')
  .action(async () => {
    try {
      await listCommand();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw health
clawCmd
  .command('health <name>')
  .description('Show Claw health status')
  .action(async (name: string) => {
    try {
      await healthCommand(name);
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw send
clawCmd
  .command('send <name> <message>')
  .description('Send a message to a Claw inbox')
  .option('--priority <level>', 'Message priority (critical/high/normal/low)', 'normal')
  .action(async (name: string, message: string, opts: { priority: string }) => {
    try {
      // 验证 priority 值
      const validPriorities = ['critical', 'high', 'normal', 'low'];
      if (!validPriorities.includes(opts.priority)) {
        throw new CliError(`Invalid priority: ${opts.priority}. Must be one of: ${validPriorities.join(', ')}`);
      }
      await sendCommand(name, message, { priority: opts.priority as 'critical' | 'high' | 'normal' | 'low' });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw outbox
clawCmd
  .command('outbox <name>')
  .description('Read and consume outbox messages from a Claw')
  .option('--limit <n>', 'Max messages to read (default: 1)', '1')
  .action(async (name: string, opts: { limit: string }) => {
    try {
      loadGlobalConfig();
      const { audit } = createDirContext(getClawDir(name));
      await outboxCommand(name, { limit: parseInt(opts.limit, 10) }, { audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw trace
clawCmd
  .command('trace')
  .description('Show claw execution trace for a contract')
  .requiredOption('--claw <id>', 'Target claw ID')
  .requiredOption('--contract <contractId>', 'Contract ID')
  .option('--step <n>', 'Show full content of step N (no truncation)', parseInt)
  .action(async (opts: { claw: string; contract: string; step?: number }) => {
    try {
      const { clawTraceCommand } = await import('./commands/claw.js');
      await clawTraceCommand(opts.claw, opts.contract, opts.step);
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// claw daemon (auto-backgrounds)
clawCmd
  .command('daemon <name>')
  .description('Start Claw daemon (auto-backgrounds)')
  .action(async (name: string) => {
    try {
      // 前台入口：后台启动
      const { loadGlobalConfig, clawExists, getClawDir, getGlobalConfigPath } = await import('../foundation/config/index.js');
      const { NodeFileSystem } = await import('../foundation/fs/node-fs.js');
      const { createSystemAudit } = await import('../foundation/audit/index.js');
      const { createAgentProcessManager } = await import('../foundation/process-manager/agent-factory.js');
      loadGlobalConfig();
      if (!clawExists(name)) {
        throw new CliError(`Claw "${name}" does not exist`);
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
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

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
  .action(async () => {
    try {
      const { audit } = createDirContext(getClawforumRoot());
      await motionInitCommand(false, { audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// motion chat
motionCmd
  .command('chat')
  .description('Chat with Motion')
  .action(async () => {
    try {
      await motionChatCommand();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// motion stop
motionCmd
  .command('stop')
  .description('Stop Motion daemon')
  .action(async () => {
    try {
      const { audit } = createDirContext(getClawforumRoot());
      await motionStopCommand({ audit });
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// motion daemon (auto-backgrounds)
motionCmd
  .command('daemon')
  .description('Start Motion daemon (auto-backgrounds)')
  .action(async () => {
    try {
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
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

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
  .requiredOption('--claw <id>', 'Target claw ID')
  .option('--file <path>', 'Path to contract YAML file')
  .option('--dir <path>', 'Directory containing contract.yaml and acceptance/ folder')
  .action(async (opts: { claw: string; file?: string; dir?: string }) => {
    try {
      loadGlobalConfig();
      const { audit } = createDirContext(getClawDir(opts.claw));
      if (opts.file && opts.dir) {
        throw new CliError('--file and --dir are mutually exclusive');
      } else if (opts.file) {
        await contractCreateCommand(opts.claw, opts.file, { audit });
      } else if (opts.dir) {
        await contractCreateFromDirCommand(opts.claw, opts.dir, { audit });
      } else {
        throw new CliError('must provide --file or --dir');
      }
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

contractCmd
  .command('log')
  .description('Show contract execution log for a claw')
  .requiredOption('--claw <id>', 'Target claw ID')
  .option('--contract <id>', 'Contract ID (default: active contract)')
  .action(async (opts: { claw: string; contract?: string }) => {
    try {
      await contractLogCommand(opts.claw, opts.contract);
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

contractCmd
  .command('events <claw>')
  .description('Show contract events since a timestamp')
  .requiredOption('--since <timestamp>', 'Unix timestamp in milliseconds')
  .action(async (claw: string, opts: { since: string }) => {
    try {
      await contractEventsCommand(claw, parseInt(opts.since, 10));
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

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
  .option('--claw <id>', 'Target claw ID (internal mode: install from dispatch-skills to claw)')
  .option('--skill <name>', 'Skill name (required with --claw)')
  .action(async (source: string | undefined, opts: { claw?: string; skill?: string }) => {
    try {
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
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

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
  .action(async () => {
    try {
      await watchdogStart();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// watchdog stop
watchdogCmd
  .command('stop')
  .description('Stop watchdog')
  .action(async () => {
    try {
      await watchdogStop();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

// watchdog daemon (internal command, spawned by startCommand)
watchdogCmd
  .command('daemon')
  .description('Run watchdog daemon (internal)')
  .action(async () => {
    try {
      await runWatchdogLoop();
    } catch (error) {
      process.exitCode = handleCliError(error);
    }
  });

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
