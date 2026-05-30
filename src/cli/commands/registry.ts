/**
 * @module L6.CLI
 * phase 1469: CLI command string typed const registry.
 *
 * 提供 motion guidance composer 编译期 check CLI 字面命令 typo / stale CLI 命令的 typed surface。
 * 配 invariant test (`tests/foundation/assembly/guidance-cli-typed-const.test.ts`) enforce composer
 * 输出文本内的 `clawforum X Y` 模式字面必经此 const 引用、禁裸字符串。
 *
 * 命名规则：
 *   - <NOUN>_<VERB> 或 <NOUN>_<NOUN> upper-snake
 *   - 字面 = `clawforum <subcommand> <verb>` 模板（不含 args 占位、占位由 composer 自家拼）
 *
 * 待立（per CLI-by-need doctrine in `design/modules/l2_messaging.md §10.6`）：
 *   - CONTRACT_CANCEL / CONTRACT_PAUSE / CONTRACT_RESUME — phase γ1 同步补 CLI wiring
 */

export const CLI_COMMANDS = {
  // Claw 观察类
  CLAW_AUDIT: 'clawforum claw audit',          // + <claw> [path]
  CLAW_DIALOG: 'clawforum claw dialog',        // + <claw>
  CLAW_TRACE: 'clawforum claw trace',          // + <claw> <contract>
  CLAW_READ: 'clawforum claw read',            // + <claw> <path>
  CLAW_HEALTH: 'clawforum claw health',        // + <claw>
  CLAW_STEPS: 'clawforum claw steps',          // + <claw>
  CLAW_OUTBOX: 'clawforum claw outbox',        // + <claw> [--limit N]

  // Claw 干预类
  CLAW_SEND: 'clawforum claw send',            // + <claw> "<message>"
  CLAW_STOP: 'clawforum claw stop',            // + <claw>
  CLAW_DAEMON: 'clawforum claw daemon',        // + <claw>

  // Contract 类（user 自家观察）
  CONTRACT_LOG: 'clawforum contract log',      // (motion 自家、无 args)
  CONTRACT_EVENTS: 'clawforum contract events',// + <claw>

  // 待立（phase γ1+ 同步补 CLI wiring per CLI-by-need doctrine）
  // CONTRACT_CANCEL: 'clawforum contract cancel',   // + <claw> [<id>]
  // CONTRACT_PAUSE: 'clawforum contract pause',     // + <claw> [<id>] [reason]
  // CONTRACT_RESUME: 'clawforum contract resume',   // + <claw> [<id>]
} as const;

export type CliCommand = typeof CLI_COMMANDS[keyof typeof CLI_COMMANDS];
