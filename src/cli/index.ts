/**
 * Chestnut CLI - Command line interface
 */

// 设置工作区根路径，供 exec 子进程继承（子进程 CWD 是 clawDir，但不一定在 .chestnut 下）
if (!process.env.CHESTNUT_ROOT) {
  process.env.CHESTNUT_ROOT = process.cwd();
}

import { program, Help } from 'commander';
import { CliError } from './errors.js';
import { cliAction, cliDeferredRequiredAction, type EnsureSupervision, type SupervisionPolicy } from './supervision-policy.js';
// `initCommand` and `startCommand` are lazy-loaded inside their action handlers
// (phase 1379): these modules transitively pull in llm-orchestrator + core/contract
// + foundation/tools (combined ~10s vitest cold load), forcing every CLI subcommand
// (e.g. `claw daemon`) to pay that cost. Lazy imports defer the cost to the user
// who actually runs `start` or `init`.
import { NodeFileSystem } from '../foundation/fs/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { dispatchClawSubcommand } from './commands/claw-router.js';
import { renderClawHelp } from '../cli-protocol/index.js';

import {
  initCommand as motionInitCommand,
  chatCommand as motionChatCommand,
  stopCommand as motionStopCommand,
  motionOutboxCommand,
  DEFAULT_OUTBOX_DRAIN_LIMIT,
} from './commands/motion.js';
import { contractCreateCommand, contractCreateFromDirCommand, contractShowCommand, contractEventsCommand, contractCancelCommand } from './commands/contract.js';
import { skillInstallUserCommand, skillInstallClawCommand } from './commands/skill.js';
import { startCommand as watchdogStart, stopCommand as watchdogStop } from './commands/watchdog-cli.js';
import { createConfigCommand } from './commands/config.js';
import { stopAllCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { createSubagentCommand } from './commands/subagent.js';
import { motionStepsCommand, motionStepCommand } from './commands/motion-steps.js';
import { actionAuditFor } from './action-scope.js';
import { getChestnutRoot, getClawDir } from '../foundation/claw-identity/index.js';
// phase 1301 Step A：CLI composition root 只从 Assembly barrel 取 factory，
// 在 fsFactory 定义后集中创建一次 RootConfig，index 自身 guard 与 router 共用同一实例。
import { createRootConfig, createRootConfigLegacyMigration, createContractActionContext } from '../assembly/index.js';
import { AUDIT_FILE_STEM } from '../foundation/audit/index.js';
// phase 1874 Step L: motion 族命令形状经 CLIProtocol catalog 投影（summary/options 单源）
import { getMotionCommandSpec, getContractCommandSpec, getMiscCommandSpec, getRootCommandSpec, applyCommandOptions, type MotionCommandId, type ContractCommandId, type MiscCommandId, type CommandShapeRegistrar } from '../cli-protocol/index.js';
// CLAWS_DIR removed: phase 263
import { parseIntOption } from './parse-int-option.js';
import { collectColFilter } from './commands/audit-query.js';

function action<TArgs extends unknown[]>(
  policy: SupervisionPolicy,
  handler: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return cliAction(policy, handler, { fsFactory });
}

// phase 1280: 复合命令（start）的 bootstrap→supervise→run 入口；ensure 时机交给 handler。
function deferredRequiredAction<TArgs extends unknown[]>(
  handler: (ensureSupervision: EnsureSupervision, ...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return cliDeferredRequiredAction(handler, { fsFactory });
}

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });
// phase 1301 Step A：composition root 唯一构造点（无 IO）；后续 command 族迁移沿用同一实例。
const rootConfig = createRootConfig({ fsFactory });
const rootConfigLegacy = createRootConfigLegacyMigration({ fsFactory });

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
program.addCommand(createConfigCommand({ fsFactory, rootConfig, rootConfigLegacy }));

// stop command
rootShape(program.command('stop'), 'stop')
  .action(action('disabled', async () => {
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    await stopAllCommand({ fsFactory, rootConfig }, { audit });
  }));

// status command
rootShape(program.command('status'), 'status')
  .action(action('observe_only', async () => {
    await statusCommand({ fsFactory, rootConfig });
  }));

// start command
rootShape(program.command('start'), 'start')
  .action(deferredRequiredAction(async (ensureSupervision) => {
    const { startCommand } = await import('./commands/start.js');
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    await startCommand({ fsFactory, rootConfig, rootConfigLegacy }, { audit, ensureSupervision });
  }));

// init command
rootShape(program.command('init'), 'init')
  .action(action('disabled', async () => {
    const { initCommand } = await import('./commands/init.js');
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    await initCommand({ fsFactory, rootConfig }, false, { audit });
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
    action('disabled', async (subject: string | undefined, args: string[]) => {
      await dispatchClawSubcommand(subject, args, { fsFactory, rootConfig });
    }),
  );
// Replace commander's default help output with CLIProtocol-driven text.
clawCommand.helpInformation = () => `${renderClawHelp()}\n`;

// motion command group
// phase 1874 Step L: 命令形状投影（catalog 单源；1798 形态泛化）
function shapeCmd<T extends { description(desc: string): unknown } & CommandShapeRegistrar>(
  cmd: T,
  spec: { summary: string; options?: readonly { flag: string; desc: string; required?: boolean; runtimeLiteral?: true }[] } | undefined,
  label: string,
  literals?: Readonly<Record<string, (registrar: T) => void>>,
): T {
  if (!spec) throw new Error(`unknown command id in catalog: ${label}`);
  cmd.description(spec.summary);
  applyCommandOptions(cmd, spec as never, literals);
  return cmd;
}
function motionShape<T extends { description(desc: string): unknown } & CommandShapeRegistrar>(cmd: T, id: MotionCommandId): T {
  return shapeCmd(cmd, getMotionCommandSpec(id), `motion/${id}`);
}
function contractShape<T extends { description(desc: string): unknown } & CommandShapeRegistrar>(cmd: T, id: ContractCommandId): T {
  return shapeCmd(cmd, getContractCommandSpec(id), `contract/${id}`);
}
function miscShape<T extends { description(desc: string): unknown } & CommandShapeRegistrar>(
  cmd: T,
  id: MiscCommandId,
  literals?: Readonly<Record<string, (registrar: T) => void>>,
): T {
  return shapeCmd(cmd, getMiscCommandSpec(id), id, literals);
}
function rootShape<T extends { description(desc: string): unknown } & CommandShapeRegistrar>(cmd: T, id: 'stop' | 'status' | 'start' | 'init'): T {
  return shapeCmd(cmd, getRootCommandSpec(id), id);
}

const motionCmd = program
  .command('motion')
  .description('Manage Motion (system orchestrator)');

// motion init
motionShape(motionCmd.command('init'), 'init')
  .action(action('disabled', async () => {
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    await motionInitCommand({ fsFactory }, false, { audit });
  }));

// motion chat
motionShape(motionCmd.command('chat'), 'chat')
  .action(action('required', async () => {
    await motionChatCommand({ fsFactory, rootConfig });
  }));

// motion stop
motionShape(motionCmd.command('stop'), 'stop')
  .action(action('disabled', async () => {
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    await motionStopCommand({ fsFactory, rootConfig }, { audit });
  }));

// motion outbox
motionShape(motionCmd.command('outbox'), 'outbox')
  // runtimeLiteral（1798 边界）：运行时 default 常量留注册点字面
  .option('--limit <n>', 'Maximum messages to drain', String(DEFAULT_OUTBOX_DRAIN_LIMIT))
  .action(action('required', async (options: { limit: string }) => {
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    const limit = parseIntOption(options.limit, '--limit must be a non-negative integer');
    await motionOutboxCommand({ fsFactory }, { limit }, { audit });
  }));

// motion steps
motionShape(motionCmd.command('steps'), 'steps')
  .action(action('observe_only', async (opts: { hint?: boolean }) => {
    await motionStepsCommand({ fsFactory }, { noHint: opts.hint === false });
  }));

// motion step
motionShape(motionCmd.command('step <n>'), 'step')
  .action(action('observe_only', async (n: string) => {
    await motionStepCommand({ fsFactory }, n);
  }));

// motion daemon (auto-backgrounds)
motionShape(motionCmd.command('daemon'), 'daemon')
  .action(action('internal', async () => {
    const { motionDaemonCommand } = await import('./commands/motion-daemon.js');
    const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
    await motionDaemonCommand({ fsFactory, rootConfig }, { audit });
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
contractShape(contractCmd.command('create'), 'create')
  .action(action('required', async (opts: { claw: string; file?: string; dir?: string }) => {
    rootConfig.loadGlobal();
    const audit = actionAuditFor(getClawDir(opts.claw), { fsFactory });
    if (opts.file && opts.dir) {
      throw new CliError('--file and --dir are mutually exclusive. Use one of --file or --dir, not both.');
    } else if (opts.file) {
      await contractCreateCommand({ fsFactory }, opts.claw, opts.file, { audit });
    } else if (opts.dir) {
      // phase 1874 Step F: contract action 装配归 Assembly 窄入口（CLI 不再构造全栈）；
      // dispose 由入口 own、动作终态统一释放。
      const contractAction = await createContractActionContext(
        { fsFactory },
        opts.claw,
        { withSummonVerifyPolicy: true },
      );
      try {
        await contractCreateFromDirCommand({ fsFactory, contractSystem: contractAction.system }, opts.claw, opts.dir, { audit });
      } finally {
        contractAction.dispose();
      }
    } else {
      throw new CliError('must provide --file or --dir');
    }
  }));

contractShape(contractCmd.command('show'), 'show')
  .action(action('observe_only', async (opts: { claw: string; contract?: string }) => {
    await contractShowCommand({ fsFactory }, opts.claw, opts.contract);
  }));

contractShape(contractCmd.command('cancel'), 'cancel')
  .action(action('required', async (opts: { claw: string; reason: string; contract?: string }) => {
    rootConfig.loadGlobal();
    const audit = actionAuditFor(getClawDir(opts.claw), { fsFactory });
    await contractCancelCommand({ fsFactory }, opts.claw, opts.reason, opts.contract, { audit });
  }));

contractShape(contractCmd.command('events <claw>'), 'events')
  .action(action('observe_only', async (claw: string, opts: { since: string }) => {
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

miscShape(skillCmd.command('install [source]'), 'skill/install')
  .action(action('required', async (source: string | undefined, opts: { claw?: string; skill?: string }) => {
    if (opts.claw) {
      if (!opts.skill) {
        throw new CliError('--skill <name> is required with --claw');
      }
      rootConfig.loadGlobal();
      const audit = actionAuditFor(getClawDir(opts.claw), { fsFactory });
      await skillInstallClawCommand({ fsFactory }, opts.claw, opts.skill, { audit });
    } else {
      if (!source) {
        throw new CliError('source path is required');
      }
      const audit = actionAuditFor(getChestnutRoot(), { fsFactory });
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

// watchdog start / stop（phase 1874 Step L: 形状经 misc catalog 投影）
miscShape(watchdogCmd.command('start'), 'watchdog/start')
  .action(action('disabled', async () => {
    await watchdogStart(fsFactory);
  }));

miscShape(watchdogCmd.command('stop'), 'watchdog/stop')
  .action(action('disabled', async () => {
    await watchdogStop(fsFactory);
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
miscShape(auditCmd.command('query'), 'audit/query', {
  // runtimeLiteral（1798 边界）：AUDIT_FILE_STEM 默认值 / --col fn parser——就地注册保序
  '--file <name>': (c) => { c.option('--file <name>', 'Audit file name (multi-file aware)', AUDIT_FILE_STEM); },
  '--col <key=val>': (c) => { c.option('--col <key=val>', 'Col filter (AND semantics, repeatable)', collectColFilter, {}); },
})
  .action(action('observe_only', async (opts: {
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
    await auditQueryCommand({ fsFactory, rootConfig }, {
      ...opts,
      fromSeq: opts.fromSeq !== undefined ? parseIntOption(opts.fromSeq, '--from-seq must be a number') : undefined,
      toSeq: opts.toSeq !== undefined ? parseIntOption(opts.toSeq, '--to-seq must be a number') : undefined,
      limit: opts.limit !== undefined ? parseIntOption(opts.limit, '--limit must be a number') : undefined,
      step: opts.step !== undefined ? parseIntOption(opts.step, '--step must be a number') : undefined,
      noHint: opts.hint === false,  // commander --no-hint sets hint=false; explicit false → noHint=true
    });
  }));

// audit lookup
miscShape(auditCmd.command('lookup'), 'audit/lookup', {
  // runtimeLiteral（1798 边界）：AUDIT_FILE_STEM 默认值——就地注册保序
  '--file <name>': (c) => { c.option('--file <name>', 'Audit file name (multi-file aware)', AUDIT_FILE_STEM); },
})
  .action(action('observe_only', async (opts: {
    claw: string;
    file: string;
    toolUseId?: string;
    blockId?: string;
    contentHash?: string;
    json?: boolean;
  }) => {
    const { auditLookupCommand } = await import('./commands/audit-lookup.js');
    await auditLookupCommand({ fsFactory, rootConfig }, opts);
  }));

// audit info
miscShape(auditCmd.command('info'), 'audit/info')
  .action(action('observe_only', async (opts: {
    claw: string;
    json?: boolean;
  }) => {
    const { auditInfoCommand } = await import('./commands/audit-info.js');
    await auditInfoCommand({ fsFactory, rootConfig }, opts);
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
