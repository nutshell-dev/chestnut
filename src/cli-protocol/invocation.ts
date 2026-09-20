/**
 * @module L6.CLIProtocol.Invocation
 *
 * Phase 1253 Step B 立：CLI invocation renderer + contract invocation 常量。
 * Phase 1270 Step A：两个 file-level export 退役为 CLIProtocol 模块内部实现 ——
 * 仅供同模块 `guidance.ts` 相对 import，不再经 `src/cli-protocol/index.ts`
 * public barrel 对模块外公开（CLI affordance 公共入口为 typed guidance
 * action/document/register API）；CLIProtocol 外源码禁止 deep-import 本文件
 * （tests/foundation/assembly/guidance-cli-typed-const.test.ts 反向 scanner）。
 *
 * 职责：
 * - `renderClawInvocation(clawId, command)` 拼 `chestnut claw <id> <command>` 完整
 *   invocation；command 参数收窄为 `ClawInstanceCommandId`（catalog 派生 literal union）、
 *   flat `list`/`help` 编译期不可传入（M#9）
 * - `CONTRACT_COMMANDS`：contract 命令族 invocation 常量（subject 已是 contract /
 *   verb-first 子命令、不走 subject-first 转换）；phase 1877 Step C 起值由
 *   `CONTRACT_COMMAND_CATALOG`（phase 1874 Step L 立的 summary/options 单源）派生 ——
 *   catalog 改名/删除 verb → 编译期传播到本常量（M#9），guidance 与 parser/help
 *   共享同一 catalog（cli-protocol-contract-command-partial 收口）。
 *
 * 历史：源自 phase 554/708 `src/cli/utils/cli-commands.ts`（claw invocation helper +
 * 手写 verb 表 + CONTRACT_COMMANDS）。phase 1253 删手写 verb 表这个第二单源
 * （与 catalog 漂移：缺 ls/ps、含孤儿 `read-state`），调用方改用 literal command id。
 */

import type { ClawInstanceCommandId } from './claw-command-catalog.js';
import type { ContractCommandId } from './contract-command-catalog.js';

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
 * contract verb → `chestnut contract <id>` invocation（id 收窄为 catalog 派生
 * literal union：catalog 外的 verb 编译期不可传入）。
 */
function renderContractInvocation(id: ContractCommandId): string {
  return `${CLI_BINARY} contract ${id}`;
}

/**
 * Contract 命令族 invocation 常量 —— 值由 `CONTRACT_COMMAND_CATALOG` id 派生
 * （同名导出保持、消费点零改）；catalog 增 pause/resume 条目后在此补派生
 * （per CLI-by-need doctrine in `design/modules/l2_messaging.md §10.6`）。
 * 字面命令需要 args 时由调用方自家拼 `${CONTRACT_COMMANDS.CANCEL} -c <id>`。
 */
export const CONTRACT_COMMANDS = {
  SHOW: renderContractInvocation('show'),     // -c <claw> [--contract <id>]
  EVENTS: renderContractInvocation('events'), // <claw> --since <ts>
  CANCEL: renderContractInvocation('cancel'), // -c <claw> --reason <text> [--contract <id>]
} as const;
