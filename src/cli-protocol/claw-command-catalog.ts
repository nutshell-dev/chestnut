/**
 * @module L6.CLIProtocol.ClawCommandCatalog
 *
 * Phase 1253 Step B 立：claw 命令族 catalog 单源。
 *
 * 单源原则：claw command 的合法集合只由本 catalog 派生——
 * - literal command id union 由 `as const satisfies` 编译期保留（M#9）
 * - router 的 instance command 集合 = `CLAW_INSTANCE_COMMAND_IDS`（form === 'instance' 派生）
 * - help renderer / invocation renderer 内用本 catalog、调用方不可注入另一份 command universe
 *
 * 形态约定：
 * - `list` / `help` 是 flat command（无 `<claw-name>`、subject 直接是 command 字面），
 *   不可传给 instance invocation renderer（类型层区分）
 * - 其余 command 是 instance command（subject = claw name / args[0] = command）
 * - `help` 自身也纳入 catalog（phase 1477 D5 ratify、防双源）但 help renderer 自己出
 *   Usage 段已含 help 入口字面、不重复列「help」行于分组列表中。
 *
 * 历史：内容源自 phase 1477 `src/cli/help/claw-verb-facts.ts` CLAW_VERB_FACTS
 * （19 项：17 instance + 2 flat）；phase 1253 迁 CLIProtocol 改 catalog、
 * 字段 `name` → `id`，summary/options/examples 字面零行为变化。
 */

import type { ClawCommandSpec } from './command-spec.js';

// 与 src/foundation/messaging/types.ts PRIORITY_ORDER 保持同步：
// critical/high/normal/low 顺序决定 help 渲染与校验顺序。
const PRIORITY_ORDER = ['critical', 'high', 'normal', 'low'] as const;

/** claw outbox read 默认读取条数。 */
export const DEFAULT_OUTBOX_READ_LIMIT = 1;

export const CLAW_COMMAND_CATALOG = [
  // ── Lifecycle ──────────────────────────────────────────────────────────
  {
    id: 'create',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Create a new claw and start its daemon',
    examples: ['chestnut claw alice create'],
  },
  {
    id: 'stop',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Stop the claw daemon',
    examples: ['chestnut claw alice stop'],
  },
  {
    id: 'daemon',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Start the claw daemon explicitly (auto-backgrounds)',
    examples: ['chestnut claw alice daemon'],
  },
  {
    id: 'health',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Check claw daemon liveness',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['chestnut claw alice health', 'chestnut claw alice health --json'],
  },
  {
    id: 'status',
    group: 'lifecycle',
    form: 'instance',
    summary: 'Show current runtime status of the claw',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['chestnut claw alice status'],
  },

  // ── Messaging ──────────────────────────────────────────────────────────
  {
    id: 'chat',
    group: 'messaging',
    form: 'instance',
    summary: 'Open an interactive chat with the claw',
    examples: ['chestnut claw alice chat'],
  },
  {
    id: 'send',
    group: 'messaging',
    form: 'instance',
    summary: "Deliver a message to the claw's inbox",
    args: [{ name: 'message', required: true, desc: 'Message body' }],
    options: [
      {
        flag: '--priority <level>',
        desc: 'Message priority',
        defaultValue: `normal (${PRIORITY_ORDER.join('|')})`,
      },
    ],
    examples: [
      'chestnut claw alice send "please check the build"',
      'chestnut claw alice send "urgent" --priority high',
    ],
  },
  {
    id: 'outbox',
    group: 'messaging',
    form: 'instance',
    summary: "Read the claw's outbox (pulled messages are marked consumed)",
    options: [{ flag: '--limit <n>', desc: 'Max messages to read', defaultValue: String(DEFAULT_OUTBOX_READ_LIMIT) }],
    examples: ['chestnut claw alice outbox', 'chestnut claw alice outbox --limit 5'],
  },
  {
    id: 'read',
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
    id: 'import',
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
    id: 'ls',
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
    id: 'stream',
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
    id: 'steps',
    group: 'observation',
    form: 'instance',
    summary: 'List recorded LLM call steps for the claw',
    examples: ['chestnut claw alice steps'],
  },
  {
    id: 'step',
    group: 'observation',
    form: 'instance',
    summary: 'Show full detail of a single LLM step',
    args: [{ name: 'n', required: true, desc: 'Step index (1-based)' }],
    examples: ['chestnut claw alice step 7'],
  },
  {
    id: 'trace',
    group: 'observation',
    form: 'instance',
    summary: 'Show contract execution trace for a claw',
    options: [
      // phase 1480: required: true → renderer 顶层显此 flag 字面、避免 silent-X
      { flag: '--contract <contractId>', desc: 'Contract ID', required: true },
      // phase 1484: N or N.x form, aligned with `claw step N.x`
      { flag: '--step <n>', desc: 'Show full content of step N or N.x (e.g. 5 or 5.a)' },
    ],
    examples: [
      'chestnut claw alice trace --contract C-123',
      'chestnut claw alice trace --contract C-123 --step 5.a',
    ],
  },
  {
    id: 'ps',
    group: 'observation',
    form: 'instance',
    summary: 'List background exec tasks running for the claw',
    examples: ['chestnut claw motion ps'],
  },

  // ── Discovery (flat commands) ──────────────────────────────────────────
  {
    id: 'list',
    group: 'discovery',
    form: 'flat',
    summary: 'List all claws in the workspace',
    options: [{ flag: '--json', desc: 'Output as JSON (machine-readable)' }],
    examples: ['chestnut claw list', 'chestnut claw list --json'],
  },
  {
    id: 'help',
    group: 'discovery',
    form: 'flat',
    summary: 'Show top-level help, or per-verb help when a verb name follows',
    args: [{ name: 'verb', required: false, desc: 'Verb name to describe in detail' }],
    examples: ['chestnut claw help', 'chestnut claw help send'],
  },
] as const satisfies readonly ClawCommandSpec[];

/** 全部 claw command literal id（含 flat `list`/`help`）。 */
export type ClawCommandId = (typeof CLAW_COMMAND_CATALOG)[number]['id'];

/** instance command literal id（form === 'instance' 派生、flat 不可构造 invocation）。 */
export type ClawInstanceCommandId = Extract<
  (typeof CLAW_COMMAND_CATALOG)[number],
  { form: 'instance' }
>['id'];

/**
 * instance command id 集合（router dispatch 的合法集合运行时来源）。
 * 派生 type guard/cast 集中在本 owner、调用方不得各自断言。
 */
export const CLAW_INSTANCE_COMMAND_IDS = CLAW_COMMAND_CATALOG
  .filter((spec) => spec.form === 'instance')
  .map((spec) => spec.id) as readonly ClawInstanceCommandId[];

/** 按 id 查 command spec（大小写敏感）。未注册返回 undefined。 */
export function getClawCommandSpec(id: string): ClawCommandSpec | undefined {
  return CLAW_COMMAND_CATALOG.find((spec) => spec.id === id);
}
