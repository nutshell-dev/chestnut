/**
 * @module L6.CLI
 * phase 1469 立 / phase 1476 reframe: CLI command string typed const + helper registry.
 *
 * 提供 motion guidance composer 编译期 check CLI 字面命令 typo / stale CLI 命令的 typed surface。
 * 配 invariant test (`tests/foundation/assembly/guidance-cli-typed-const.test.ts`) enforce composer
 * 输出文本内的 `chestnut X Y` 模式字面必经此 const / helper 引用、禁裸字符串。
 *
 * **phase 1472 silent X drift fix**：phase 1469 原 `CLI_COMMANDS` const 用 verb-first 字面
 * （`chestnut claw outbox`）/ phase 1472 翻 subject-first（`chestnut claw <name> outbox`）
 * 漏更 registry → phase 1476 修：claw 命令族改 `clawCmd(id, verb)` helper 拼装、verb 走 `CLAW_VERBS`
 * typed const enum。contract 命令族（subject 已是 contract / verb-first 子命令）保字面 const。
 */

/**
 * Claw 命令族 verb fragment（subject-first `chestnut claw <name> <verb>` 形态、phase 1472）.
 * 来源：`src/cli/commands/claw-router.ts` VERB_NAMES（14 verb / 必同步）.
 */
export const CLAW_VERBS = {
  CREATE: 'create',
  CHAT: 'chat',
  STOP: 'stop',
  HEALTH: 'health',
  SEND: 'send',
  OUTBOX: 'outbox',
  IMPORT: 'import',
  READ: 'read',
  READ_STATE: 'read-state',
  STEPS: 'steps',
  STEP: 'step',
  DAEMON: 'daemon',
  TRACE: 'trace',
  STATUS: 'status',
  WATCH: 'watch',     // phase 5: subscribe to one-shot inactivity follow-up
  STREAM: 'stream',   // phase 447: tail stream.jsonl as JSONL events to stdout
} as const;

export type ClawVerb = typeof CLAW_VERBS[keyof typeof CLAW_VERBS];

/**
 * 拼 `chestnut claw <id> <verb>` 完整 invocation.
 *
 * `id` 形态：
 *   - 真 claw id 字符串 (e.g. 'clawA')
 *   - 占位符 `<claw-id>` 或 `<id>` 给 motion LLM 自家填（summary 多 claw 场景）
 */
export function clawCmd(id: string, verb: ClawVerb): string {
  return `chestnut claw ${id} ${verb}`;
}

/**
 * Contract 命令族（subject 已是 contract / verb-first 子命令、不走 subject-first 转换）.
 * 字面命令需要 args 时由 composer 自家拼 `${CONTRACT_COMMANDS.CANCEL} -c <id>`.
 */
export const CONTRACT_COMMANDS = {
  SHOW: 'chestnut contract show',        // -c <claw> [--contract <id>]
  EVENTS: 'chestnut contract events',    // <claw> --since <ts>
  CANCEL: 'chestnut contract cancel',    // -c <claw> --reason <text> [--contract <id>]
  // 待立（per CLI-by-need doctrine in `design/modules/l2_messaging.md §10.6`）：
  // PAUSE: 'chestnut contract pause',     // -c <claw> [--contract <id>] [--reason <text>]
  // RESUME: 'chestnut contract resume',   // -c <claw> [--contract <id>]
} as const;

export type ContractCommand = typeof CONTRACT_COMMANDS[keyof typeof CONTRACT_COMMANDS];
