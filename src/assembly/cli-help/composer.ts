/**
 * @module L6.Assembly.CliHelp.Composer
 *
 * Phase 1477：把命令族 verb-fact 拼成最终 CLI help 文本。
 *
 * 职责：
 * - 拥有 binary 字面 `clawforum`（Assembly 是装配方、本就需知部署形态）
 * - 拥有分组顺序、格式约定、缩进对齐等渲染选择
 * - 输出两形态：顶层 help（全 verb 分组）+ 单 verb help（详尽参数）
 *
 * 应然边界：
 * - 不知 commander 实例（输出纯字符串、由 cli 层注入 commander helpInformation）
 * - 不知具体业主 module（仅消费 VerbFact[]）
 *
 * 同型参考：assembly/motion-guidance-composer.ts（phase 1472 同模式 + 本 phase γ-help 镜像）。
 */

import type { VerbFact, VerbGroup, RetiredVerbNote } from '../../foundation/cli-help/index.js';

/** CLI binary 字面 —— 与 motion-guidance-composer 同源约定、Assembly 内 source of truth。 */
const CLI_BINARY = 'clawforum';

const GROUP_HEADERS: Record<VerbGroup, string> = {
  lifecycle: 'Lifecycle:',
  messaging: 'Messaging:',
  observation: 'Observation:',
  discovery: 'Discovery:',
};

const GROUP_ORDER: readonly VerbGroup[] = ['lifecycle', 'messaging', 'observation', 'discovery'];

/** Pad a verb signature (col 1) to a fixed column so summaries align. */
const SIGNATURE_COL = 32;

function padRight(s: string, n: number): string {
  if (s.length >= n) return `${s}  `;
  return s + ' '.repeat(n - s.length);
}

/** Render a verb's argument list (e.g., `<message>`, `[verb]`). Excludes options. */
function renderArgList(fact: VerbFact): string {
  if (!fact.args || fact.args.length === 0) return '';
  return ' ' + fact.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}

/** Render a single verb's one-line entry for the top-level group list. */
function renderVerbLine(fact: VerbFact): string {
  const signature = `  ${fact.name}${renderArgList(fact)}`;
  return `${padRight(signature, SIGNATURE_COL)}${fact.summary}`;
}

function renderGroup(group: VerbGroup, facts: readonly VerbFact[]): string[] {
  const groupFacts = facts.filter((f) => f.group === group);
  if (groupFacts.length === 0) return [];
  return [GROUP_HEADERS[group], ...groupFacts.map(renderVerbLine), ''];
}

function renderExamples(facts: readonly VerbFact[]): string[] {
  // Surface up to 1 example per verb that has any, capped to keep help compact.
  const lines: string[] = ['Examples:'];
  for (const fact of facts) {
    if (fact.examples && fact.examples.length > 0) {
      lines.push(`  ${fact.examples[0]}`);
    }
  }
  return [...lines, ''];
}

function renderRetiredFooter(retired: readonly RetiredVerbNote[]): string[] {
  if (retired.length === 0) return [];
  const lines: string[] = ['Notes:'];
  for (const r of retired) {
    const note = r.note ? ` (${r.note})` : '';
    lines.push(`  \`${r.retired}\` has been retired — use \`${r.replacement}\` instead.${note}`);
  }
  return lines;
}

/**
 * Compose top-level `clawforum claw --help` text.
 *
 * Layout: Usage block + 4 verb groups + Examples + retired footer.
 * Replaces commander's default `Usage: clawforum claw [options] <subject> [args...]`
 * which is opaque to users (`<subject>` is a commander internal abstraction).
 */
export function composeClawHelp(
  facts: readonly VerbFact[],
  retired: readonly RetiredVerbNote[] = [],
): string {
  const lines: string[] = [];

  // Usage — three forms, all surfaced.
  lines.push('Usage:');
  lines.push(`  ${CLI_BINARY} claw <claw-name> <verb> [args]    Operate on a specific claw`);
  lines.push(`  ${CLI_BINARY} claw list [--json]                List all claws`);
  lines.push(`  ${CLI_BINARY} claw help [<verb>]                Show this help / per-verb help`);
  lines.push('');

  // Groups.
  for (const group of GROUP_ORDER) {
    lines.push(...renderGroup(group, facts));
  }

  // Examples.
  lines.push(...renderExamples(facts));

  // Retired verbs footer.
  lines.push(...renderRetiredFooter(retired));

  return lines.join('\n');
}

/**
 * Compose per-verb help: `clawforum claw help <verb>` or `claw <name> <verb> --help`.
 *
 * Layout: signature + summary + args + options + examples + note.
 */
export function composeClawVerbHelp(fact: VerbFact): string {
  const lines: string[] = [];

  // Signature line — depends on form.
  const verbSig = `${fact.name}${renderArgList(fact)}`;
  if (fact.form === 'instance') {
    lines.push(`Usage: ${CLI_BINARY} claw <claw-name> ${verbSig}`);
  } else {
    lines.push(`Usage: ${CLI_BINARY} claw ${verbSig}`);
  }
  lines.push('');
  lines.push(fact.summary);
  lines.push('');

  if (fact.args && fact.args.length > 0) {
    lines.push('Arguments:');
    for (const a of fact.args) {
      const bracket = a.required ? `<${a.name}>` : `[${a.name}]`;
      const desc = a.desc ? `  ${a.desc}` : '';
      lines.push(`  ${padRight(bracket, 20)}${desc}`);
    }
    lines.push('');
  }

  if (fact.options && fact.options.length > 0) {
    lines.push('Options:');
    for (const o of fact.options) {
      const tail = o.defaultValue ? ` (default: ${o.defaultValue})` : '';
      lines.push(`  ${padRight(o.flag, 24)}${o.desc}${tail}`);
    }
    lines.push('');
  }

  if (fact.examples && fact.examples.length > 0) {
    lines.push('Examples:');
    for (const e of fact.examples) {
      lines.push(`  ${e}`);
    }
    lines.push('');
  }

  if (fact.note) {
    lines.push(`Note: ${fact.note}`);
  }

  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/** Find a verb fact by name (case-sensitive). Returns undefined if not registered. */
export function findVerbFact(
  facts: readonly VerbFact[],
  name: string,
): VerbFact | undefined {
  return facts.find((f) => f.name === name);
}
