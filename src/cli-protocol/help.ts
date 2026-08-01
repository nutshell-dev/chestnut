/**
 * @module L6.CLIProtocol.Help
 *
 * Phase 1253 Step C：claw help renderer 归 CLIProtocol（迁自
 * `src/assembly/cli-help/composer.ts` phase 1477，输出逐字兼容）。
 *
 * 职责：
 * - 拥有 binary 字面 `chestnut`、分组顺序、格式约定、缩进对齐等渲染选择
 *   （全部 file-private、调用方只见 barrel 的 render API）
 * - 输出两形态：顶层 help（全 command 分组）+ 单 command help（详尽参数）
 *
 * 应然边界：
 * - renderer 固定读取 CLIProtocol owner catalog；调用方不能注入另一份 command universe
 * - 不知 commander 实例（输出纯字符串、由 CLIProcess 注入 commander helpInformation）
 * - 零实现依赖：不 import CLIProcess / Assembly（M#5、dependency-cruiser ratchet 守）
 */

import {
  CLAW_COMMAND_CATALOG,
  getClawCommandSpec,
} from './claw-command-catalog.js';
import type { ClawCommandSpec, CommandGroup } from './command-spec.js';

/** CLI binary 字面 —— CLIProtocol 内 file-private。 */
const CLI_BINARY = 'chestnut';

const GROUP_HEADERS: Record<CommandGroup, string> = {
  lifecycle: 'Lifecycle:',
  messaging: 'Messaging:',
  observation: 'Observation:',
  discovery: 'Discovery:',
};

const GROUP_ORDER: readonly CommandGroup[] = ['lifecycle', 'messaging', 'observation', 'discovery'];

/**
 * Pad a verb signature (col 1) to a fixed column so summaries align.
 * Derivation: 32 char 覆盖 typical CLI verb signature 如 `chestnut motion start <opts>` /
 * 配 80-col terminal 留 48 col 给 summary description / 比 NAME_PAD (18) 长 ≈ 2× 因
 * signature 含 verb + opts 综合.
 */
const SIGNATURE_COL = 32;

function padRight(s: string, n: number): string {
  if (s.length >= n) return `${s}  `;
  return s + ' '.repeat(n - s.length);
}

/** Render a command's positional argument list (e.g., `<message>`, `[verb]`). Excludes options. */
function renderArgList(spec: ClawCommandSpec): string {
  if (!spec.args || spec.args.length === 0) return '';
  return ' ' + spec.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}

/**
 * Render the command signature tail for the **top-level** help row.
 *
 * = positional args + required-option flag literals (phase 1480).
 *
 * Surfacing required options prevents the silent-X where the top-level help
 * row shows just the command name (e.g. `trace`), but the command refuses to run
 * without a required option (e.g. `--contract <id>`). Optional options stay
 * hidden at the top level — users discover them via `claw help <command>`.
 */
function renderTopLevelSignatureTail(spec: ClawCommandSpec): string {
  const args = renderArgList(spec);
  const requiredOpts = (spec.options ?? [])
    .filter((o) => o.required === true)
    .map((o) => ` ${o.flag}`)
    .join('');
  return `${args}${requiredOpts}`;
}

/** Render a single command's one-line entry for the top-level group list. */
function renderCommandLine(spec: ClawCommandSpec): string {
  const signature = `  ${spec.id}${renderTopLevelSignatureTail(spec)}`;
  return `${padRight(signature, SIGNATURE_COL)}${spec.summary}`;
}

function renderGroup(group: CommandGroup, specs: readonly ClawCommandSpec[]): string[] {
  const groupSpecs = specs.filter((s) => s.group === group);
  if (groupSpecs.length === 0) return [];
  return [GROUP_HEADERS[group], ...groupSpecs.map(renderCommandLine), ''];
}

/**
 * Compose top-level `chestnut claw --help` text.
 *
 * Layout: Usage block + command groups.
 * Replaces commander's default `Usage: chestnut claw [options] <subject> [args...]`
 * which is opaque to users (`<subject>` is a commander internal abstraction).
 * Per-command examples live on `claw help <command>`, not in the top-level summary.
 */
function composeClawHelp(specs: readonly ClawCommandSpec[]): string {
  const lines: string[] = [];

  // Usage — three forms, all surfaced.
  lines.push('Usage:');
  lines.push(`  ${CLI_BINARY} claw <claw-name> <verb> [args]    Operate on a specific claw`);
  lines.push(`  ${CLI_BINARY} claw list [--json]                List all claws`);
  lines.push(`  ${CLI_BINARY} claw help [<verb>]                Show this help / per-verb help`);
  lines.push('');

  // Groups.
  for (const group of GROUP_ORDER) {
    lines.push(...renderGroup(group, specs));
  }

  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/**
 * Compose per-command help: `chestnut claw help <command>` or `claw <name> <command> --help`.
 *
 * Layout: signature + summary + args + options + examples + note.
 */
function composeClawCommandHelp(spec: ClawCommandSpec): string {
  const lines: string[] = [];

  // Signature line — depends on form.
  const cmdSig = `${spec.id}${renderArgList(spec)}`;
  if (spec.form === 'instance') {
    lines.push(`Usage: ${CLI_BINARY} claw <claw-name> ${cmdSig}`);
  } else {
    lines.push(`Usage: ${CLI_BINARY} claw ${cmdSig}`);
  }
  lines.push('');
  lines.push(spec.summary);
  lines.push('');

  if (spec.args && spec.args.length > 0) {
    lines.push('Arguments:');
    for (const a of spec.args) {
      const bracket = a.required ? `<${a.name}>` : `[${a.name}]`;
      const desc = a.desc ? `  ${a.desc}` : '';
      lines.push(`  ${padRight(bracket, 20)}${desc}`);
    }
    lines.push('');
  }

  if (spec.options && spec.options.length > 0) {
    lines.push('Options:');
    for (const o of spec.options) {
      const requiredMark = o.required === true ? ' (required)' : '';
      const defaultTail = o.defaultValue ? ` (default: ${o.defaultValue})` : '';
      lines.push(`  ${padRight(o.flag, 24)}${o.desc}${requiredMark}${defaultTail}`);
    }
    lines.push('');
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push('Examples:');
    for (const e of spec.examples) {
      lines.push(`  ${e}`);
    }
    lines.push('');
  }

  if (spec.note) {
    lines.push(`Note: ${spec.note}`);
  }

  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/** Render top-level claw help（固定读取 CLIProtocol owner catalog）。 */
export function renderClawHelp(): string {
  return composeClawHelp(CLAW_COMMAND_CATALOG);
}

/**
 * Render per-command help. 内部 query catalog；unknown id 返回 undefined
 * （router 依赖此语义转 CliError、不得改 throw）。
 */
export function renderClawCommandHelp(id: string): string | undefined {
  const spec = getClawCommandSpec(id);
  if (!spec) return undefined;
  return composeClawCommandHelp(spec);
}
