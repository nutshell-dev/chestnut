/**
 * Chestnut CLI - Command line interface
 */

// 设置工作区根路径，供 exec 子进程继承（子进程 CWD 是 clawDir，但不一定在 .chestnut 下）
if (!process.env.CHESTNUT_ROOT) {
  process.env.CHESTNUT_ROOT = process.cwd();
}

import { program, Help } from 'commander';
import { CliError } from './errors.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';
// `initCommand` and `startCommand` are lazy-loaded inside their action handlers
// (phase 1379): these modules transitively pull in llm-orchestrator + core/contract
// + foundation/tools (combined ~10s vitest cold load), forcing every CLI subcommand
// (e.g. `claw daemon`) to pay that cost. Lazy imports defer the cost to the user
// who actually runs `start` or `init`.
import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { dispatchClawSubcommand, renderClawTopHelp } from './commands/claw-router.js';

import {
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
  stopCommand as motionStopCommand,
} from './commands/motion.js';
import { contractCreateCommand, contractCreateFromDirCommand, contractShowCommand, contractEventsCommand, contractCancelCommand } from './commands/contract.js';
import { skillInstallUserCommand, skillInstallClawCommand } from './commands/skill.js';
import { runWatchdogLoop, startCommand as watchdogStart, stopCommand as watchdogStop } from '../watchdog/watchdog.js';
import { DAEMON_LOG } from '../daemon/constants.js';
import { createConfigCommand } from './commands/config.js';
import { stopAllCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { createSubagentCommand } from './commands/subagent.js';
import { motionStepsCommand, motionStepCommand } from './commands/motion-steps.js';
import { createDirContext } from '../foundation/audit/index.js';
import { getChestnutRoot, getClawDir } from '../core/claw-topology/claw-instance-paths.js';
import { loadGlobalConfig } from '../assembly/config-load.js';
import { createSummonVerifyPolicy } from '../core/summon-system/index.js';
import { createContractSystem } from '../core/contract/index.js';
import { resolveChestnutRoot } from '../core/claw-topology/claw-instance-paths.js';
// CLAWS_DIR removed: phase 263
import { createSystemAudit } from '../foundation/audit/index.js';
import { routeNotifyClaw } from '../core/claw-topology/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { createToolRegistry } from '../foundation/tools/index.js';
import { createFileTools } from '../foundation/file-tool/index.js';
import { parseIntOption } from './parse-int-option.js';
import { collectColFilter } from './commands/audit-query.js';

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

program
  .name('chestnut')
  .description('AI Agent Orchestration System')
  .version('0.1.0')
  // phase 1472：`claw <subject> [args...]` 子命令用 passThroughOptions、要求父级 enablePositionalOptions
  .enablePositionalOptions();

// phase 1488: 顶层 `chestnut --help` Commands 列表里 `claw` 行清掉 commander
// 默认渲染出的 `[subject] [args...]` 内部抽象、与 motion/contract/skill 等命令
// family 同形显示。
//
// 实现：仅在 cmd.name() === 'claw' 时返回纯 name；其他命令走 commander Help 类
// 默认 subcommandTerm（保留 `step <n>` / `help [command]` 等正常 positional 显示）。
//
// 注：commander v13 的 configureHelp 会沿 subcommand 链继承、子命令同 cmd.name
// 字面才命中、其他 cmd 走 default 路径不破。
{
  const defaultSubcommandTerm = new Help().subcommandTerm.bind(new Help());
  program.configureHelp({
    subcommandTerm: (cmd) =>
      cmd.name() === 'claw' ? cmd.name() : defaultSubcommandTerm(cmd),
  });
}

// config command
program.addCommand(createConfigCommand({ fsFactory }));

// stop command
program
  .command('stop')
  .description('Stop all chestnut processes (watchdog → motion → claws)')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext({ fsFactory }, getChestnutRoot());
    await stopAllCommand({ fsFactory }, { audit });
  }));

// status command
program
  .command('status')
  .description('Show status of all chestnut processes')
  .action(withCliErrorHandling(async () => {
    await statusCommand({ fsFactory });
  }));

// start command
program
  .command('start')
  .description('Start the system (initializes if needed) and open Motion chat')
  .action(withCliErrorHandling(async () => {
    const { startCommand } = await import('./commands/start.js');
    const { audit } = createDirContext({ fsFactory }, getChestnutRoot());
    await startCommand({ fsFactory }, { audit });
  }));

// init command
program
  .command('init')
  .description('Initialize chestnut workspace')
  .action(withCliErrorHandling(async () => {
    const { initCommand } = await import('./commands/init.js');
    const { audit } = createDirContext({ fsFactory }, getChestnutRoot());
    await initCommand({ fsFactory }, false, { audit });
  }));

// claw command group — phase 1472：subject-first 形态 / phase 1477：composer-driven help
//
//   chestnut claw <name> <verb> [args...]    一般形态：作用在指定 claw 上
//   chestnut claw list [--json]              平面形态：跨 claw 列表
//   chestnut claw help [<verb>]              composer-driven help 入口（phase 1477 α）
//
// 详 src/cli/commands/claw-router.ts。commander v13 `passThroughOptions(true)`
// 把 `<subject>` 之后所有 token 原样塞进 [args...]、由 router 按 verb 解析。
//
// phase 1477：用 composer 输出顶层 help、替 commander 默认 `Usage: ... <subject> [args...]`
// （`<subject>` 是 commander 内部抽象、用户不需关心）。.helpOption(false) 关闭
// commander 自家 -h/--help 处理（避免 "Usage: chestnut claw [options]" 头部漏出），
// 由 router 内自家拦 `--help` / `-h` + `claw help [<verb>]` 关键字。顶层 `claw --help`
// 也由 router 拦截（args 含 `--help` 当 verbToken 处理）。
const clawCommand = program
  .command('claw [subject] [args...]')
  .description('Manage Claws (run `chestnut claw help` for full reference)')
  .passThroughOptions()
  .allowUnknownOption()
  .helpOption(false)
  .action(
    withCliErrorHandling(async (subject: string | undefined, args: string[]) => {
      await dispatchClawSubcommand(subject, args, { fsFactory });
    }),
  );
// Replace commander's default help output with composer-driven text.
clawCommand.helpInformation = () => `${renderClawTopHelp()}\n`;

// motion command group
const motionCmd = program
  .command('motion')
  .description('Manage Motion (system orchestrator)');

// motion init
motionCmd
  .command('init')
  .description('Initialize Motion configuration')
  .action(withCliErrorHandling(async () => {
    const { audit } = createDirContext({ fsFactory }, getChestnutRoot());
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
    const { audit } = createDirContext({ fsFactory }, getChestnutRoot());
    await motionStopCommand({ fsFactory }, { audit });
  }));

// motion steps
motionCmd
  .command('steps')
  .description('Show motion turn steps')
  .option('--no-hint', 'Suppress step <n> usage hint')
  .action(withCliErrorHandling(async (opts: { hint?: boolean }) => {
    await motionStepsCommand({ fsFactory }, { noHint: opts.hint === false });
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
    loadGlobalConfig({ fsFactory });
    const { audit } = createDirContext({ fsFactory }, getClawDir(opts.claw));
    if (opts.file && opts.dir) {
      throw new CliError('--file and --dir are mutually exclusive. Use one of --file or --dir, not both.');
    } else if (opts.file) {
      await contractCreateCommand({ fsFactory }, opts.claw, opts.file, { audit });
    } else if (opts.dir) {
      // Phase 230 / phase 281 Step B: create ContractSystem + wire SummonVerifyPolicy
      const clawDir = getClawDir(opts.claw);
      const clawFs = fsFactory(clawDir);
      const chestnutRoot = resolveChestnutRoot(clawDir, /* isMotion */ false);
      const clawAudit = createSystemAudit(clawFs, clawDir);
      // phase 281 Step B: CLI manual contract create 无 subagentTaskId，loadTask 不被调用。
      const summonVerifyPolicy = createSummonVerifyPolicy({ loadTask: async () => undefined, auditWriter: clawAudit });

      // phase 257: wire ClawTopology 到 ContractSystem 的 ToolRegistry
      const toolRegistry = createToolRegistry();
      for (const tool of createFileTools()) {
        toolRegistry.register(tool);
      }
      const { wireClawTopology } = await import('../assembly/wire-claw-topology.js');
      wireClawTopology({
        fs: clawFs,
        chestnutRoot,
        audit: clawAudit,
        toolRegistry,
      });

      const contractSystem = createContractSystem({
        clawDir,
        clawId: makeClawId(opts.claw),
        fs: clawFs,
        audit: clawAudit,
        toolRegistry,
        fsFactory,
        notifyClaw: (targetClawId, message) => routeNotifyClaw(clawFs, chestnutRoot, MOTION_CLAW_ID, targetClawId, message, clawAudit),
      });
      contractSystem.registerCreatePolicy('summon-verify', summonVerifyPolicy);

      await contractCreateFromDirCommand({ fsFactory, contractSystem }, opts.claw, opts.dir, { audit });
    } else {
      throw new CliError('must provide --file or --dir');
    }
  }));

contractCmd
  .command('show')
  .description('Show contract state snapshot for a claw')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--contract <id>', 'Contract ID (default: active contract)')
  .action(withCliErrorHandling(async (opts: { claw: string; contract?: string }) => {
    await contractShowCommand({ fsFactory }, opts.claw, opts.contract);
  }));

contractCmd
  .command('cancel')
  .description('Cancel an active or paused contract (moves to archive with status=cancelled)')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .requiredOption('--reason <text>', 'Cancel reason (recorded in progress checkpoint)')
  .option('--contract <id>', 'Contract ID (default: active contract)')
  .action(withCliErrorHandling(async (opts: { claw: string; reason: string; contract?: string }) => {
    loadGlobalConfig({ fsFactory });
    const { audit } = createDirContext({ fsFactory }, getClawDir(opts.claw));
    await contractCancelCommand({ fsFactory }, opts.claw, opts.reason, opts.contract, { audit });
  }));

contractCmd
  .command('events <claw>')
  .description('Show contract events since a timestamp')
  .requiredOption('--since <timestamp>', 'Unix timestamp in milliseconds')
  .action(withCliErrorHandling(async (claw: string, opts: { since: string }) => {
    const since = parseIntOption(opts.since, '--since must be a Unix timestamp in milliseconds');
    await contractEventsCommand({ fsFactory }, claw, since);
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
      loadGlobalConfig({ fsFactory });
      const { audit } = createDirContext({ fsFactory }, getClawDir(opts.claw));
      await skillInstallClawCommand({ fsFactory }, opts.claw, opts.skill, { audit });
    } else {
      if (!source) {
        throw new CliError('source path is required');
      }
      const { audit } = createDirContext({ fsFactory }, getChestnutRoot());
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
    // phase 444 Step B DI：装配传入 daemon stdout log（M#5 watchdog 不直 import daemon）。
    await runWatchdogLoop(fsFactory, DAEMON_LOG);
  }));

watchdogCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of watchdogCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// audit command group
const auditCmd = program
  .command('audit')
  .description('Audit log query and inspection (read-only)');

// audit query
auditCmd
  .command('query')
  .description('Query audit log records with filters and optional follow')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--file <name>', "Audit file name (default 'audit'; multi-file aware)", 'audit')
  .option('--all-files', 'Query across all audit files in this claw')
  .option('--type <pattern>', 'Glob pattern matched against event type (e.g. cron_*)')
  .option('--since-ts <iso>', 'Inclusive lower bound on ts (ISO 8601)')
  .option('--until-ts <iso>', 'Inclusive upper bound on ts (ISO 8601)')
  .option('--from-seq <n>', 'Inclusive lower bound on seq')
  .option('--to-seq <n>', 'Inclusive upper bound on seq')
  .option('--trace <id>', 'Exact trace_id match')
  .option('--col <key=val>', 'Col filter (AND semantics, repeatable)', collectColFilter, {})
  .option('--limit <n>', 'Max records to yield')
  .option('--json', 'Output as JSON-line (default TSV passthrough)')
  .option('--follow', 'Tail mode: emit existing then watch for new appends')
  // phase 152 新加 typed filter flag
  .option('--tool-use-id <id>', 'Filter by tool_use_id (exact match)')
  .option('--step <n>', 'Filter by step number (exact match)')
  .option('--contract-id <id>', 'Filter by contract_id (exact match)')
  .option('--subtask-id <id>', 'Filter by subtask_id (exact match)')
  .option('--no-hint', 'Suppress 0 result hint to stderr')
  .action(withCliErrorHandling(async (opts: {
    claw: string;
    file: string;
    allFiles?: boolean;
    type?: string;
    sinceTs?: string;
    untilTs?: string;
    fromSeq?: string;
    toSeq?: string;
    trace?: string;
    col?: Record<string, string>;
    limit?: string;
    json?: boolean;
    follow?: boolean;
    toolUseId?: string;
    step?: string;
    contractId?: string;
    subtaskId?: string;
    hint?: boolean;  // commander --no-X flag: --no-hint sets hint=false (default true)
  }) => {
    const { auditQueryCommand } = await import('./commands/audit-query.js');
    await auditQueryCommand({ fsFactory }, {
      ...opts,
      fromSeq: opts.fromSeq !== undefined ? parseIntOption(opts.fromSeq, '--from-seq must be a number') : undefined,
      toSeq: opts.toSeq !== undefined ? parseIntOption(opts.toSeq, '--to-seq must be a number') : undefined,
      limit: opts.limit !== undefined ? parseIntOption(opts.limit, '--limit must be a number') : undefined,
      step: opts.step !== undefined ? parseIntOption(opts.step, '--step must be a number') : undefined,
      noHint: opts.hint === false,  // commander --no-hint sets hint=false; explicit false → noHint=true
    });
  }));

// audit lookup
auditCmd
  .command('lookup <toolUseId>')
  .description('Look up full tool content by tool_use_id (4-level fallback: current → archive → hash → unavailable)')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--file <name>', "Audit file name (default 'audit'; multi-file aware)", 'audit')
  .option('--content-hash <sha8>', 'Optional sha8 hash for integrity verification (level 3 fallback)')
  .option('--json', 'Output as JSON (LookupResult discriminated union)')
  .action(withCliErrorHandling(async (toolUseId: string, opts: {
    claw: string;
    file: string;
    contentHash?: string;
    json?: boolean;
  }) => {
    const { auditLookupCommand } = await import('./commands/audit-lookup.js');
    await auditLookupCommand({ fsFactory }, toolUseId, opts);
  }));

// audit info
auditCmd
  .command('info')
  .description('Show audit file metadata and schema routing')
  .requiredOption('-c, --claw <id>', 'Target claw ID')
  .option('--json', 'Output as JSON')
  .action(withCliErrorHandling(async (opts: {
    claw: string;
    json?: boolean;
  }) => {
    const { auditInfoCommand } = await import('./commands/audit-info.js');
    await auditInfoCommand({ fsFactory }, opts);
  }));

auditCmd.on('command:*', (ops) => {
  console.error(`error: unknown command '${ops[0]}'\n`);
  console.error('Available commands:');
  for (const c of auditCmd.commands) {
    console.error(`  ${c.name().padEnd(12)}  ${c.description()}`);
  }
  process.exitCode = 1;
});

// subagent command group
program.addCommand(createSubagentCommand({ fsFactory }));

program.parse();
