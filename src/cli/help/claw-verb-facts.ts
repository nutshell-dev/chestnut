/**
 * @module L6.Cli.Help.ClawVerbFacts
 *
 * Phase 1477 立 / phase 1479 layering fix（从 foundation/cli-help 挪 cli/help）。
 *
 * claw 命令族 verb-fact 单源。
 *
 * 单源原则：本表与 `cli/commands/claw-router.ts` 的 VERB_NAMES 一一对应、
 * 由 invariant test 守（`tests/cli/help/claw-verb-facts.test.ts`）。
 *
 * 添加新 verb / 改名时必须同步本表与 router VERB_NAMES，否则编译期类型 check
 * + 运行时 invariant 至少一道会报。
 *
 * 形态约定：
 * - `list` / `help` 是 flat verb（无 `<claw-name>`、subject 直接是 verb 字面）
 * - 其余 verb 是 instance verb（subject = claw name / args[0] = verb）
 * - `help` 自身也纳入 fact 表（D5 ratify、防双源）但 composer 自己出 Usage 段
 *   已含 help 入口字面、不重复列「help」行于分组列表中。
 */

import type { VerbFact } from './types.js';

export const CLAW_VERB_FACTS: readonly VerbFact[] = [
  // ── Lifecycle ──────────────────────────────────────────────────────────
  {
    name: 'create',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Create a new claw and start its daemon',
    examples: ['chestnut claw alice create'],
  },
  {
    name: 'stop',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Stop the claw daemon',
    examples: ['chestnut claw alice stop'],
  },
  {
    name: 'daemon',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Start the claw daemon explicitly (auto-backgrounds)',
    examples: ['chestnut claw alice daemon'],
  },
  {
    name: 'health',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Check claw daemon liveness',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['chestnut claw alice health', 'chestnut claw alice health --json'],
  },
  {
    name: 'status',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Show current runtime status of the claw',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['chestnut claw alice status'],
  },
  {
    name: 'watch',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Subscribe to a one-shot notification if the claw remains inactive after a duration',
    options: [{ flag: '--inactive-after <duration>', desc: 'Duration (e.g. 5m / 30m / 1h, max 24h). Default 5m.' }],
    examples: ['chestnut claw alice watch', 'chestnut claw alice watch --inactive-after 30m'],
  },

  // ── Messaging ──────────────────────────────────────────────────────────
  {
    name: 'chat',
    group: 'messaging',
    form: 'instance',
    summary: 'Open an interactive chat with the claw',
    examples: ['chestnut claw alice chat'],
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
      'chestnut claw alice send "please check the build"',
      'chestnut claw alice send "urgent" --priority high',
    ],
  },
  {
    name: 'outbox',
    group: 'messaging',
    form: 'instance',
    summary: "Read the claw's outbox (pulled messages are marked consumed)",
    options: [{ flag: '--limit <n>', desc: 'Max messages to read', defaultValue: '1' }],
    examples: ['chestnut claw alice outbox', 'chestnut claw alice outbox --limit 5'],
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
    examples: ['chestnut claw alice read notes/today.md'],
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
      'chestnut claw alice import ./design.md',
      'chestnut claw alice import ./drafts -t inbox',
    ],
  },
  {
    name: 'ls',
    group: 'messaging',
    form: 'instance',
    summary: "List files in the claw's clawspace",
    args: [{ name: 'path', required: false, desc: 'Subdirectory within clawspace (default: root)' }],
    options: [
      { flag: '-r, --recursive', desc: 'List recursively' },
      { flag: '--json', desc: 'Output as JSON (machine-readable)' },
    ],
    examples: [
      'chestnut claw alice ls',
      'chestnut claw alice ls notes',
      'chestnut claw alice ls --recursive',
    ],
  },
  {
    name: 'stream',
    group: 'messaging',
    form: 'instance',
    summary: 'Tail the claw stream.jsonl as JSONL events to stdout (long-running)',
    options: [
      { flag: '--from-recent-turn', desc: 'Start from the recent turn boundary (default)' },
      { flag: '--from-now', desc: 'Start from end of file (only new appends)' },
      { flag: '--include-history', desc: 'Replay full history then tail' },
      { flag: '--from-offset <N>', desc: 'Start from byte offset N' },
    ],
    examples: [
      'chestnut claw motion stream',
      'chestnut claw motion stream --from-now',
      'chestnut claw alice stream --include-history > alice.log',
    ],
  },

  // ── Observation ────────────────────────────────────────────────────────
  {
    name: 'steps',
    group: 'observation',
    form: 'instance',
    summary: 'List recorded LLM call steps for the claw',
    examples: ['chestnut claw alice steps'],
  },
  {
    name: 'step',
    group: 'observation',
    form: 'instance',
    summary: 'Show full detail of a single LLM step',
    args: [{ name: 'n', required: true, desc: 'Step index (1-based)' }],
    examples: ['chestnut claw alice step 7'],
  },
  {
    name: 'trace',
    group: 'observation',
    form: 'instance',
    summary: 'Show contract execution trace for a claw',
    options: [
      // phase 1480: required: true → composer 顶层显此 flag 字面、避免 silent-X
      { flag: '--contract <contractId>', desc: 'Contract ID', required: true },
      // phase 1484: N or N.x form, aligned with `claw step N.x`
      { flag: '--step <n>', desc: 'Show full content of step N or N.x (e.g. 5 or 5.a)' },
    ],
    examples: [
      'chestnut claw alice trace --contract C-123',
      'chestnut claw alice trace --contract C-123 --step 5.a',
    ],
  },

  // ── Discovery (flat verbs) ─────────────────────────────────────────────
  {
    name: 'list',
    group: 'discovery',
    form: 'flat',
    summary: 'List all claws in the workspace',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['chestnut claw list', 'chestnut claw list --json'],
  },
  {
    name: 'help',
    group: 'discovery',
    form: 'flat',
    summary: 'Show top-level help, or per-verb help when a verb name follows',
    args: [{ name: 'verb', required: false, desc: 'Verb name to describe in detail' }],
    examples: ['chestnut claw help', 'chestnut claw help send'],
  },
] as const;

export type ClawVerbName = (typeof CLAW_VERB_FACTS)[number]['name'];

/** verb 名集合（运行时 lookup / invariant 守同 router VERB_NAMES）。 */
export const CLAW_VERB_NAMES: readonly ClawVerbName[] = CLAW_VERB_FACTS.map((f) => f.name) as readonly ClawVerbName[];
