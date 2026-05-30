/**
 * @module L1.CliHelp.ClawVerbFacts
 *
 * Phase 1477：claw 命令族 verb-fact 单源。
 *
 * 单源原则：本表与 `cli/commands/claw-router.ts` 的 VERB_NAMES 一一对应、
 * 由 invariant test 守（`tests/foundation/cli-help/claw-verb-facts.test.ts`）。
 *
 * 添加新 verb / 改名时必须同步本表与 router VERB_NAMES，否则编译期类型 check
 * + 运行时 invariant 至少一道会报。
 *
 * 形态约定：
 * - `list` / `help` 是 flat verb（无 `<claw-name>`、subject 直接是 verb 字面）
 * - 其余 14 verb 是 instance verb（subject = claw name / args[0] = verb）
 * - `help` 自身也纳入 fact 表（D5 ratify、防双源）但本 phase 不在 help 输出中
 *   重复列出 "help" 行（composer 自己出 Usage 段已含 help 入口字面）
 */

import type { VerbFact, RetiredVerbNote } from './types.js';

export const CLAW_VERB_FACTS: readonly VerbFact[] = [
  // ── Lifecycle ──────────────────────────────────────────────────────────
  {
    name: 'create',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Create a new claw and start its daemon',
    examples: ['clawforum claw alice create'],
  },
  {
    name: 'stop',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Stop the claw daemon',
    examples: ['clawforum claw alice stop'],
  },
  {
    name: 'daemon',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Start the claw daemon explicitly (auto-backgrounds)',
    examples: ['clawforum claw alice daemon'],
  },
  {
    name: 'health',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Check claw daemon liveness',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['clawforum claw alice health', 'clawforum claw alice health --json'],
  },
  {
    name: 'status',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Show current runtime status of the claw',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['clawforum claw alice status'],
  },

  // ── Messaging ──────────────────────────────────────────────────────────
  {
    name: 'chat',
    group: 'messaging',
    form: 'instance',
    summary: 'Open an interactive chat with the claw',
    examples: ['clawforum claw alice chat'],
  },
  {
    name: 'send',
    group: 'messaging',
    form: 'instance',
    summary: "Deliver a message to the claw's inbox",
    args: [{ name: 'message', required: true, desc: 'Message body' }],
    options: [
      {
        flag: '--priority <level>',
        desc: 'Message priority',
        defaultValue: 'normal (critical|high|normal|low)',
      },
    ],
    examples: [
      'clawforum claw alice send "please check the build"',
      'clawforum claw alice send "urgent" --priority high',
    ],
  },
  {
    name: 'outbox',
    group: 'messaging',
    form: 'instance',
    summary: "Read the claw's outbox (pulled messages are marked consumed)",
    options: [{ flag: '--limit <n>', desc: 'Max messages to read', defaultValue: '1' }],
    examples: ['clawforum claw alice outbox', 'clawforum claw alice outbox --limit 5'],
  },
  {
    name: 'read',
    group: 'messaging',
    form: 'instance',
    summary: "Read a file from the claw's clawspace",
    args: [{ name: 'path', required: true, desc: 'File path within clawspace' }],
    options: [
      { flag: '--offset <n>', desc: 'Starting line (1-indexed, negative counts from end)' },
      { flag: '--limit <n>', desc: 'Max lines to read' },
    ],
    examples: ['clawforum claw alice read notes/today.md'],
  },
  {
    name: 'read-state',
    group: 'messaging',
    form: 'instance',
    summary: 'Show the inbox read cursor',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['clawforum claw alice read-state'],
  },
  {
    name: 'import',
    group: 'messaging',
    form: 'instance',
    summary: "Import an external file or directory into the claw's clawspace",
    args: [{ name: 'source', required: true, desc: 'Local file/dir to copy in' }],
    options: [
      { flag: '-t, --target <subdir>', desc: 'Target subdirectory under clawspace' },
    ],
    examples: [
      'clawforum claw alice import ./design.md',
      'clawforum claw alice import ./drafts -t inbox',
    ],
  },

  // ── Observation ────────────────────────────────────────────────────────
  {
    name: 'steps',
    group: 'observation',
    form: 'instance',
    summary: 'List recorded LLM call steps for the claw',
    examples: ['clawforum claw alice steps'],
  },
  {
    name: 'step',
    group: 'observation',
    form: 'instance',
    summary: 'Show full detail of a single LLM step',
    args: [{ name: 'n', required: true, desc: 'Step index (1-based)' }],
    examples: ['clawforum claw alice step 7'],
  },
  {
    name: 'trace',
    group: 'observation',
    form: 'instance',
    summary: 'Show contract execution trace for a claw',
    options: [
      { flag: '--contract <contractId>', desc: 'Contract ID (required)' },
      { flag: '--step <n>', desc: 'Show full content of step N (no truncation)' },
    ],
    examples: ['clawforum claw alice trace --contract C-123'],
  },

  // ── Discovery (flat verbs) ─────────────────────────────────────────────
  {
    name: 'list',
    group: 'discovery',
    form: 'flat',
    summary: 'List all claws in the workspace',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['clawforum claw list', 'clawforum claw list --json'],
  },
  {
    name: 'help',
    group: 'discovery',
    form: 'flat',
    summary: 'Show top-level help, or per-verb help when a verb name follows',
    args: [{ name: 'verb', required: false, desc: 'Verb name to describe in detail' }],
    examples: ['clawforum claw help', 'clawforum claw help send'],
  },
] as const;

/** retired verb（仅 footer 显示）。 */
export const CLAW_RETIRED_VERBS: readonly RetiredVerbNote[] = [
  {
    retired: 'cp',
    replacement: 'import',
    note: 'phase 1472 retired `cp` to remove "two-arg symmetry" misnaming',
  },
] as const;

/** verb 名集合（运行时 lookup / invariant 守同 router VERB_NAMES）。 */
export const CLAW_VERB_NAMES: readonly string[] = CLAW_VERB_FACTS.map((f) => f.name);
