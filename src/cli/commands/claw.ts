/**
 * @module L6.CLI.Claw
 * Claw command barrel re-export
 *
 * Phase 1472 Step B：CLI 形态从 `claw <verb> <name>` 翻成 `claw <name> <verb>`、
 * sub-router 在 claw-router.ts。本 barrel 仅 re-export 各 command 实现函数。
 *
 * 各 command 实现见 claw-{name}.ts:
 * helper（非 command / 不 barrel-export）：
 * - claw-shared.ts        formatRelativeTime + LLM_OUTPUT_EVENTS + getLastActiveMs
 *
 * command（下方 export）：
 * - claw-create.ts        createCommand
 * - claw-chat.ts          chatCommand
 * - claw-stop.ts          stopCommand
 * - claw-list.ts          listCommand
 * - claw-health.ts        healthCommand
 * - claw-send.ts          sendCommand
 * - claw-outbox.ts        outboxCommand
 * - claw-trace.ts         clawTraceCommand + 6 trace helper（自治 sub-module）
 * - claw-import.ts        importCommand  (phase 1472：cp → import 重命名)
 * - claw-read.ts          readCommand
 * - claw-status.ts        clawStatusCommand (phase 1472：新增 motion 用 CLI 查 claw 业务态)
 */

export { createCommand } from './claw-create.js';
export { chatCommand } from './claw-chat.js';
export { stopCommand } from './claw-stop.js';
export { listCommand } from './claw-list.js';
export { healthCommand } from './claw-health.js';
export { sendCommand } from './claw-send.js';
export { outboxCommand } from './claw-outbox.js';
export { clawTraceCommand } from './claw-trace.js';
export { importCommand } from './claw-import.js';
export { readCommand } from './claw-read.js';
export { lsCommand } from './claw-ls.js';
export { clawStatusCommand } from './claw-status.js';
export { watchCommand } from './claw-watch.js';
