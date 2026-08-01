/**
 * @module L6.CLIProtocol.Invocation
 *
 * Phase 1253 Step B 立：CLI invocation renderer + 过渡性 contract invocation 常量。
 *
 * 职责：
 * - `renderClawInvocation(clawId, command)` 拼 `chestnut claw <id> <command>` 完整
 *   invocation；command 参数收窄为 `ClawInstanceCommandId`（catalog 派生 literal union）、
 *   flat `list`/`help` 编译期不可传入（M#9）
 * - `CONTRACT_COMMANDS`：contract 命令族 invocation 常量（subject 已是 contract /
 *   verb-first 子命令、不走 subject-first 转换）
 *
 * **过渡状态登记（B 类偏差）**：`CONTRACT_COMMANDS` 是 contract 命令的过渡性局部单源，
 * 尚非完整 contract catalog（contract command 无 claw 同型 facts/router/help 结构）。
 * 升档条件：Phase 1252 guidance 迁移需要 typed contract action，或 contract help/catalog
 * 单独治理。本 phase 不宣称 contract catalog 已完成。
 *
 * 历史：源自 phase 554/708 `src/cli/utils/cli-commands.ts`（clawCmd + CLAW_VERBS +
 * CONTRACT_COMMANDS）。phase 1253 删 `CLAW_VERBS` 第二单源（与 catalog 漂移：缺 ls/ps、
 * 含孤儿 `read-state`），调用方改用 literal command id。
 */

import type { ClawInstanceCommandId } from './claw-command-catalog.js';

/** CLI binary 字面 —— CLIProtocol 内 file-private。 */
const CLI_BINARY = 'chestnut';

/**
 * 拼 `chestnut claw <id> <command>` 完整 invocation。
 *
 * `clawId` 形态：
 *   - 真 claw id 字符串 (e.g. 'clawA')
 *   - 占位符 `<claw-id>` 或 `<id>` 给 motion LLM 自家填（summary 多 claw 场景）
 */
export function renderClawInvocation(
  clawId: string,
  command: ClawInstanceCommandId,
): string {
  return `${CLI_BINARY} claw ${clawId} ${command}`;
}

/**
 * Contract 命令族（过渡性局部单源、见文件头登记）。
 * 字面命令需要 args 时由调用方自家拼 `${CONTRACT_COMMANDS.CANCEL} -c <id>`。
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
