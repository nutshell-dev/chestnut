/**
 * @module L6.CLI.Claw.Router
 *
 * Phase 1472 Step B：`claw <name> <verb> [args...]` sub-router。
 *
 * 形态决策（详 `coding plan/phase1472/Phase 1472 总览.md` §0 D1/D5/D6/D8）：
 * - claw 命令族统一 subject-first：`claw <name> <verb>` 而非旧的 `claw <verb> <name>`
 * - `claw list` 是平面操作（无 `<name>`）、单根混入（subject === 'list' 即 list verb 入口）
 * - 跨命令族（contract / skill / subagent / motion / watchdog）本 phase 不动
 * - commander 不支持「<name> 当 namespace + verb 当 subcommand 名」的动态注册、采用
 *   单根 `program.command('claw <subject> [args...]')` + 本文件 dispatch 实现
 * - `cp` verb 退役、改名 `import`（语义不再"双参数对称"误导）
 *
 * 实现：
 * - commander v13 `.passThroughOptions(true)` 把 `<subject>` 之后所有 token（含 options）
 *   原样塞进 `[args...]` variadic、由本 router 按 verb 创建 sub-Command 解析选项
 * - 各 verb 字符串与 handler 集中在 VERBS 表（编译期 Record 类型 check）
 * - subject === 'list' 走 list 分支、否则解析为 claw name + 第一个 args[0] 当 verb
 */

import { Command } from 'commander';
import {
  createCommand,
  chatCommand,
  stopCommand,
  listCommand,
  healthCommand,
  sendCommand,
  outboxCommand,
  importCommand,
  readCommand,
  lsCommand,
  clawStatusCommand,
  runStreamFromArgs,
} from './claw.js';
import { CliError } from '../errors.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { cliAction, type SupervisionPolicy } from '../supervision-policy.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
// phase 1324 Step A：RouterDeps 收敛为 Claw 命令族共享 deps 的 type alias
// （type-only barrel import）；Router 自身不再另行声明窄 RootConfig 形状。
import type { ClawCreateCommandDeps } from './claw-command-deps.js';
import { listMigratedExecTasks } from '../../core/async-task-system/index.js';
import { parseIntOption } from '../parse-int-option.js';
import { PRIORITY_ORDER, type Priority } from '../../foundation/messaging/index.js';
import { makeContractId } from '../../core/contract/index.js';
import { clawStepsCommand, clawStepCommand } from './claw-steps.js';
import { psCommand } from './claw-ps.js';
import {
  CLAW_INSTANCE_COMMAND_IDS,
  DEFAULT_OUTBOX_READ_LIMIT,
  renderClawHelp,
  renderClawCommandHelp,
  type ClawInstanceCommandId,
} from '../../cli-protocol/index.js';

export type RouterDeps = ClawCreateCommandDeps;

function verbAction<TArgs extends unknown[]>(
  policy: SupervisionPolicy,
  handler: (...args: TArgs) => Promise<void>,
  deps: RouterDeps,
): (...args: TArgs) => Promise<void> {
  return cliAction(policy, handler, { fsFactory: deps.fsFactory });
}

// ── Verb registry ───────────────────────────────────────────────────────────

// instance command 合法集合：CLIProtocol catalog 派生（单源、phase 1253）。
const INSTANCE_VERB_NAMES: readonly string[] = CLAW_INSTANCE_COMMAND_IDS;

type VerbName = ClawInstanceCommandId;

const VERB_SET: ReadonlySet<string> = new Set(INSTANCE_VERB_NAMES);

// Verb names that ALSO appear as top-level subject (flat verbs).
// Used to reject claw names that collide with reserved tokens.
// `help` joined as of phase 1477 (γ-help routing).
const RESERVED_SUBJECTS: ReadonlySet<string> = new Set(['list', 'help']);

/** Output one line to stdout (test-friendly indirection in case we capture later). */
function writeHelp(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Detect `--help` / `-h` in args. Returns the help flag if present.
 * Used to intercept `claw <name> <verb> --help` and render per-verb help
 * before the per-verb option parser sees the flag.
 */
function findHelpFlag(args: readonly string[]): boolean {
  return args.some((a) => a === '--help' || a === '-h');
}

/**
 * Make a fresh commander Command for an ad-hoc verb-scoped option parse.
 * exitOverride() so option errors throw instead of triggering process exit;
 * caller wraps in CliError.
 */
function makeVerbParser(verb: VerbName): Command {
  return new Command(verb)
    .exitOverride()
    .configureOutput({
      writeOut: () => { /* suppress help in error mode */ },
      writeErr: () => { /* suppress */ },
    });
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function dispatchClawSubcommand(
  subject: string | undefined,
  args: string[],
  deps: RouterDeps,
): Promise<void> {
  // Path 0z: bare `chestnut claw` (no subject) → top-level help. Friendlier
  // than commander's `error: missing required argument 'subject'`. Same
  // intent as `claw help` / `claw --help`.
  if (subject === undefined) {
    writeHelp(renderClawHelp());
    return;
  }

  // Path 0a: `claw --help` / `claw -h` — commander has helpOption(false) so
  // these tokens flow through as `subject` (passThroughOptions). Treat them
  // as alias of `claw help`.
  if (subject === '--help' || subject === '-h') {
    writeHelp(renderClawHelp());
    return;
  }

  // Path 0: `claw help [<verb>]` — α help routing (phase 1477).
  // `claw help` → top-level help / `claw help <verb>` → per-verb help.
  if (subject === 'help') {
    const verbToken = args[0];
    if (!verbToken) {
      writeHelp(renderClawHelp());
      return;
    }
    const verbHelp = renderClawCommandHelp(verbToken);
    if (!verbHelp) {
      throw new CliError(
        `unknown verb '${verbToken}'. available: ${INSTANCE_VERB_NAMES.join(', ')}`,
      );
    }
    writeHelp(verbHelp);
    return;
  }

  // Path 1: `claw list [--json|--summary]`
  if (subject === 'list') {
    const parser = makeVerbParser('status'); // dummy name for option parsing
    parser.option('--json', 'Output as JSON (machine-readable)');
    parser.option('--summary', 'Output as structured summary (for agent consumption)');
    try {
      parser.parse(args, { from: 'user' });
    } catch (err) {
      throw new CliError(`invalid 'claw list' options: ${(err as Error).message}`, { cause: err });
    }
    const opts = parser.opts() as { json?: boolean; summary?: boolean };
    if (opts.json && opts.summary) {
      throw new CliError("options '--json' and '--summary' are mutually exclusive");
    }
    return verbAction('observe_only', () => listCommand(deps, opts), deps)();
  }

  // Path 2: `claw <name> <verb> [args...]`
  const name = subject;
  const verbToken = args[0];
  if (!verbToken) {
    throw new CliError(
      `missing verb. usage: 'chestnut claw <name> <verb>' (available verbs: ${INSTANCE_VERB_NAMES.join(', ')})`,
    );
  }
  if (!VERB_SET.has(verbToken)) {
    throw new CliError(
      `unknown verb '${verbToken}' for claw '${name}'. available: ${INSTANCE_VERB_NAMES.join(', ')}`,
    );
  }
  // Sanity: `<name>` must not be a reserved subject token.
  if (RESERVED_SUBJECTS.has(name)) {
    throw new CliError(`'${name}' is reserved; cannot be a claw name`);
  }

  const verb = verbToken as VerbName;
  const verbArgs = args.slice(1);

  // β help intercept (phase 1477): `claw <name> <verb> --help` / `-h`
  // → render per-verb help and short-circuit before per-verb option parser
  //   (commander would otherwise error on unknown option / required arg).
  if (findHelpFlag(verbArgs)) {
    const verbHelp = renderClawCommandHelp(verb);
    // Guarded by VERB_SET above; renderClawCommandHelp must succeed.
    if (verbHelp) {
      writeHelp(verbHelp);
      return;
    }
  }

  switch (verb) {
    case 'create': return verbAction('required', () => runCreate(deps, name, verbArgs), deps)();
    case 'chat': return verbAction('required', () => runChat(deps, name, verbArgs), deps)();
    case 'stop': return verbAction('disabled', () => runStop(deps, name, verbArgs), deps)();
    case 'health': return verbAction('observe_only', () => runHealth(deps, name, verbArgs), deps)();
    case 'send': return verbAction('required', () => runSend(deps, name, verbArgs), deps)();
    case 'outbox': return verbAction('required', () => runOutbox(deps, name, verbArgs), deps)();
    case 'import': return verbAction('required', () => runImport(deps, name, verbArgs), deps)();
    case 'read': return verbAction('observe_only', () => runRead(deps, name, verbArgs), deps)();
    case 'ls': return verbAction('observe_only', () => runLs(deps, name, verbArgs), deps)();
    case 'steps': return verbAction('observe_only', () => runSteps(deps, name, verbArgs), deps)();
    case 'step': return verbAction('observe_only', () => runStep(deps, name, verbArgs), deps)();
    case 'daemon': return verbAction('internal', () => runDaemon(deps, name, verbArgs), deps)();
    case 'trace': return verbAction('observe_only', () => runTrace(deps, name, verbArgs), deps)();
    case 'status': return verbAction('observe_only', () => runStatus(deps, name, verbArgs), deps)();
    case 'ps': return verbAction('observe_only', () => runPs(deps, name, verbArgs), deps)();
    case 'stream': return verbAction('required', () => runStreamFromArgs(deps, name, verbArgs), deps)();
  }
  // Exhaustiveness guard (phase 1253)：函数返回类型 Promise<void> 下 noImplicitReturns
  // 不约束 switch 覆盖；catalog 新增 instance command 而 router 未加 case 时，
  // 此处 verb 收窄不到 never → 编译失败。不得改为 default 静默吞掉 future command。
  const _exhaustive: never = verb;
  throw new CliError(`unhandled verb '${_exhaustive}'`);
}

// ── Per-verb handlers ───────────────────────────────────────────────────────

async function runCreate(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'create' takes no extra arguments (got: ${args.join(' ')})`);
  }
  const { audit } = createDirContext(deps, getClawDir(name));
  await createCommand(deps, name, { audit });
}

async function runChat(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'chat' takes no extra arguments (got: ${args.join(' ')})`);
  }
  await chatCommand(deps, name);
}

async function runStop(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'stop' takes no extra arguments (got: ${args.join(' ')})`);
  }
  const { audit } = createDirContext(deps, getClawDir(name));
  await stopCommand(deps, name, { audit });
}

async function runHealth(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('health');
  parser.option('--json', 'Output as JSON (machine-readable)');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> health' options: ${(err as Error).message}`, { cause: err });
  }
  if (parser.args.length > 0) {
    throw new CliError(`'health' takes no positional arguments (got: ${parser.args.join(' ')})`);
  }
  await healthCommand(deps, name, parser.opts());
}

async function runSend(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('send');
  parser.argument('<message>', 'message body');
  parser.option('--priority <level>', `Message priority (${PRIORITY_ORDER.join('/')})`, 'normal');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> send' args: ${(err as Error).message}`, { cause: err });
  }
  const [message] = parser.processedArgs;
  const opts = parser.opts() as { priority: string };
  if (!PRIORITY_ORDER.includes(opts.priority as Priority)) {
    throw new CliError(`Invalid priority: ${opts.priority}. Must be one of: ${PRIORITY_ORDER.join(', ')}`);
  }
  await sendCommand(deps, name, message as string, {
    priority: opts.priority as Priority,
  });
}

async function runOutbox(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('outbox');
  parser.option('--limit <n>', 'Max messages to read', String(DEFAULT_OUTBOX_READ_LIMIT));
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> outbox' options: ${(err as Error).message}`, { cause: err });
  }
  deps.rootConfig.loadGlobal();
  const { audit } = createDirContext(deps, getClawDir(name));
  const opts = parser.opts() as { limit: string };
  const limit = parseIntOption(opts.limit, '--limit must be a non-negative integer');
  await outboxCommand(deps, name, { limit }, { audit });
}

async function runImport(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('import');
  parser.argument('<source>', 'local file/dir to copy into claw\'s clawspace');
  parser.option('-t, --target <subdir>', 'Target subdirectory under clawspace');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> import' args: ${(err as Error).message}`, { cause: err });
  }
  const [source] = parser.processedArgs;
  const opts = parser.opts() as { target?: string };
  await importCommand(deps, source as string, name, opts.target);
}

async function runRead(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('read');
  parser.argument('<path>', 'file path within clawspace');
  parser.option('--offset <n>', 'Starting line (1-indexed, negative counts from end)', (v) => parseInt(v, 10));
  parser.option('--limit <n>', 'Max lines to read', (v) => parseInt(v, 10));
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> read' args: ${(err as Error).message}`, { cause: err });
  }
  const [filePath] = parser.processedArgs;
  const opts = parser.opts() as { offset?: number; limit?: number };
  await readCommand(deps, name, filePath as string, opts);
}

async function runLs(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('ls');
  parser.argument('[path]', 'subdirectory within clawspace (default: clawspace root)');
  parser.option('-r, --recursive', 'List recursively');
  parser.option('--json', 'Output as JSON (machine-readable)');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> ls' args: ${(err as Error).message}`, { cause: err });
  }
  const [subPath] = parser.processedArgs as [string | undefined];
  const opts = parser.opts() as { recursive?: boolean; json?: boolean };
  await lsCommand(deps, name, subPath, opts);
}


async function runSteps(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('steps');
  parser.option('--no-hint', 'Suppress step <n> usage hint');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> steps' options: ${(err as Error).message}`, { cause: err });
  }
  if (parser.args.length > 0) {
    throw new CliError(`'steps' takes no extra arguments (got: ${parser.args.join(' ')})`);
  }
  const opts = parser.opts() as { hint?: boolean };
  await clawStepsCommand(deps, name, { noHint: opts.hint === false });
}

async function runStep(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length !== 1) {
    throw new CliError(`'step' requires exactly one arg <n> (got: ${args.length})`);
  }
  await clawStepCommand(deps, args[0], name);
}

async function runDaemon(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'daemon' takes no extra arguments (got: ${args.join(' ')})`);
  }
  const { clawDaemonCommand } = await import('./claw-daemon.js');
  await clawDaemonCommand(deps, name);
}

async function runTrace(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('trace');
  parser.requiredOption('--contract <contractId>', 'Contract ID');
  // phase 1484: --step 接 string (N or N.x form) / 解析推到 clawTraceCommand 与 claw step N.x 同源
  parser.option('--step <n>', 'Show full content of step N or N.x (e.g. 5 or 5.a)');
  parser.option('--no-hint', 'Suppress step <n> usage hint');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> trace' options: ${(err as Error).message}`, { cause: err });
  }
  const opts = parser.opts() as { contract: string; step?: string; hint?: boolean };
  const { clawTraceCommand } = await import('./claw.js');
  await clawTraceCommand(deps, name, makeContractId(opts.contract), opts.step, { noHint: opts.hint === false });
}

async function runStatus(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('status');
  parser.option('--json', 'Output as JSON (machine-readable)');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> status' options: ${(err as Error).message}`, { cause: err });
  }
  if (parser.args.length > 0) {
    throw new CliError(`'status' takes no positional arguments (got: ${parser.args.join(' ')})`);
  }
  await clawStatusCommand(deps, name, parser.opts());
}

async function runPs(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'ps' takes no extra arguments (got: ${args.join(' ')})`);
  }
  // phase 1301 Step B：ps existence guard 由「只看文件存在」改为 loadClaw typed load
  // （Phase1295 拍板的稳定替代）。undefined 才是 missing；schema/IO 错误原样上抛
  // fail-loud，不把损坏配置伪装成“claw 存在”或“claw 不存在”。
  if (deps.rootConfig.loadClaw(getClawConfigPath(name)) === undefined) {
    throw new CliError(`Claw "${name}" does not exist`);
  }
  const clawDir = getClawDir(name);
  const { audit } = createDirContext(deps, clawDir);
  await psCommand(
    {
      listMigratedExecTasks: (dir) => listMigratedExecTasks({
        fsFactory: deps.fsFactory,
        auditWriter: {
          write: (event, payload) => {
            const cols = Object.entries(payload).map(([key, value]) => `${key}=${String(value)}`);
            audit.write(event, ...cols);
          },
        },
      }, dir),
    },
    name,
    args,
  );
}
