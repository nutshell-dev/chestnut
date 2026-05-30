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
  readStateCommand,
  clawStatusCommand,
} from './claw.js';
import { CliError } from '../errors.js';
import { createDirContext } from '../../foundation/audit/index.js';
import { getClawDir, loadGlobalConfig } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { parseIntOption } from '../parse-int-option.js';
import { makeClawId, makeContractId } from '../../foundation/identity/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import { clawStepsCommand, clawStepCommand } from './claw-steps.js';
import {
  CLAW_VERB_FACTS,
  CLAW_RETIRED_VERBS,
  type VerbFact,
} from '../../foundation/cli-help/index.js';
import {
  composeClawHelp,
  composeClawVerbHelp,
  findVerbFact,
} from '../../assembly/cli-help/index.js';

export interface RouterDeps {
  fsFactory: (baseDir: string) => FileSystem;
}

// ── Verb registry ───────────────────────────────────────────────────────────

const VERB_NAMES = [
  'create',
  'chat',
  'stop',
  'health',
  'send',
  'outbox',
  'import',
  'read',
  'read-state',
  'steps',
  'step',
  'daemon',
  'trace',
  'status',
] as const;

type VerbName = typeof VERB_NAMES[number];

const VERB_SET: ReadonlySet<string> = new Set(VERB_NAMES);

/** Test-only re-export of VERB_NAMES so invariant tests can assert fact/router parity. */
export const __TEST_VERB_NAMES_FROM_ROUTER: readonly string[] = VERB_NAMES;

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

/** Render top-level claw help (composer-driven, replaces commander default). */
export function renderClawTopHelp(): string {
  return composeClawHelp(CLAW_VERB_FACTS, CLAW_RETIRED_VERBS);
}

/** Render per-verb help. Returns undefined if verb name not registered. */
export function renderClawVerbHelp(verbName: string): string | undefined {
  const fact = findVerbFact(CLAW_VERB_FACTS, verbName);
  if (!fact) return undefined;
  return composeClawVerbHelp(fact);
}

/** Resolve a fact by verb name (test helper). */
export function getClawVerbFact(verbName: string): VerbFact | undefined {
  return findVerbFact(CLAW_VERB_FACTS, verbName);
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
  subject: string,
  args: string[],
  deps: RouterDeps,
): Promise<void> {
  // Path 0a: `claw --help` / `claw -h` — commander has helpOption(false) so
  // these tokens flow through as `subject` (passThroughOptions). Treat them
  // as alias of `claw help`.
  if (subject === '--help' || subject === '-h') {
    writeHelp(renderClawTopHelp());
    return;
  }

  // Path 0: `claw help [<verb>]` — α help routing (phase 1477).
  // `claw help` → top-level help / `claw help <verb>` → per-verb help.
  if (subject === 'help') {
    const verbToken = args[0];
    if (!verbToken) {
      writeHelp(renderClawTopHelp());
      return;
    }
    const verbHelp = renderClawVerbHelp(verbToken);
    if (!verbHelp) {
      throw new CliError(
        `unknown verb '${verbToken}'. available: ${VERB_NAMES.join(', ')}`,
      );
    }
    writeHelp(verbHelp);
    return;
  }

  // Path 1: `claw list [--json]`
  if (subject === 'list') {
    const parser = makeVerbParser('status'); // dummy name for option parsing
    parser.option('--json', 'Output as JSON (machine-readable)');
    try {
      parser.parse(args, { from: 'user' });
    } catch (err) {
      throw new CliError(`invalid 'claw list' options: ${(err as Error).message}`);
    }
    await listCommand(deps, parser.opts());
    return;
  }

  // Path 2: `claw <name> <verb> [args...]`
  const name = subject;
  const verbToken = args[0];
  if (!verbToken) {
    throw new CliError(
      `missing verb. usage: 'clawforum claw <name> <verb>' (available verbs: ${VERB_NAMES.join(', ')})`,
    );
  }
  if (!VERB_SET.has(verbToken)) {
    throw new CliError(
      `unknown verb '${verbToken}' for claw '${name}'. available: ${VERB_NAMES.join(', ')}`,
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
    const verbHelp = renderClawVerbHelp(verb);
    // Guarded by VERB_SET above; renderClawVerbHelp must succeed.
    if (verbHelp) {
      writeHelp(verbHelp);
      return;
    }
  }

  switch (verb) {
    case 'create': return runCreate(deps, name, verbArgs);
    case 'chat': return runChat(deps, name, verbArgs);
    case 'stop': return runStop(deps, name, verbArgs);
    case 'health': return runHealth(deps, name, verbArgs);
    case 'send': return runSend(deps, name, verbArgs);
    case 'outbox': return runOutbox(deps, name, verbArgs);
    case 'import': return runImport(deps, name, verbArgs);
    case 'read': return runRead(deps, name, verbArgs);
    case 'read-state': return runReadState(deps, name, verbArgs);
    case 'steps': return runSteps(deps, name, verbArgs);
    case 'step': return runStep(deps, name, verbArgs);
    case 'daemon': return runDaemon(deps, name, verbArgs);
    case 'trace': return runTrace(deps, name, verbArgs);
    case 'status': return runStatus(deps, name, verbArgs);
  }
}

// ── Per-verb handlers ───────────────────────────────────────────────────────

async function runCreate(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'create' takes no extra arguments (got: ${args.join(' ')})`);
  }
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
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
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
  const { audit } = createDirContext(deps, getClawDir(name));
  await stopCommand(deps, name, { audit });
}

async function runHealth(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('health');
  parser.option('--json', 'Output as JSON (machine-readable)');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> health' options: ${(err as Error).message}`);
  }
  if (parser.args.length > 0) {
    throw new CliError(`'health' takes no positional arguments (got: ${parser.args.join(' ')})`);
  }
  await healthCommand(deps, name, parser.opts());
}

async function runSend(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('send');
  parser.argument('<message>', 'message body');
  parser.option('--priority <level>', 'Message priority (critical/high/normal/low)', 'normal');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> send' args: ${(err as Error).message}`);
  }
  const [message] = parser.processedArgs;
  const opts = parser.opts() as { priority: string };
  const validPriorities = ['critical', 'high', 'normal', 'low'];
  if (!validPriorities.includes(opts.priority)) {
    throw new CliError(`Invalid priority: ${opts.priority}. Must be one of: ${validPriorities.join(', ')}`);
  }
  await sendCommand(deps, name, message as string, {
    priority: opts.priority as 'critical' | 'high' | 'normal' | 'low',
  });
}

async function runOutbox(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('outbox');
  parser.option('--limit <n>', 'Max messages to read (default: 1)', '1');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> outbox' options: ${(err as Error).message}`);
  }
  loadGlobalConfig(deps, CONFIG_DEFAULTS);
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
    throw new CliError(`invalid 'claw <name> import' args: ${(err as Error).message}`);
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
    throw new CliError(`invalid 'claw <name> read' args: ${(err as Error).message}`);
  }
  const [filePath] = parser.processedArgs;
  const opts = parser.opts() as { offset?: number; limit?: number };
  await readCommand(deps, name, filePath as string, opts);
}

async function runReadState(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('read-state');
  parser.option('--json', 'Output as JSON (machine-readable)');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> read-state' options: ${(err as Error).message}`);
  }
  await readStateCommand(deps, name, parser.opts());
}

async function runSteps(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`'steps' takes no extra arguments (got: ${args.join(' ')})`);
  }
  await clawStepsCommand(deps, name);
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
  parser.option('--step <n>', 'Show full content of step N (no truncation)', (v) => parseInt(v, 10));
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> trace' options: ${(err as Error).message}`);
  }
  const opts = parser.opts() as { contract: string; step?: number };
  const { clawTraceCommand } = await import('./claw.js');
  await clawTraceCommand(deps, makeClawId(name), makeContractId(opts.contract), opts.step);
}

async function runStatus(deps: RouterDeps, name: string, args: string[]): Promise<void> {
  const parser = makeVerbParser('status');
  parser.option('--json', 'Output as JSON (machine-readable)');
  try {
    parser.parse(args, { from: 'user' });
  } catch (err) {
    throw new CliError(`invalid 'claw <name> status' options: ${(err as Error).message}`);
  }
  if (parser.args.length > 0) {
    throw new CliError(`'status' takes no positional arguments (got: ${parser.args.join(' ')})`);
  }
  await clawStatusCommand(deps, name, parser.opts());
}

