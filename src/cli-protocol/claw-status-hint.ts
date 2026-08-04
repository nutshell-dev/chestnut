/**
 * @module L6.CLIProtocol.ClawStatusHint
 *
 * Phase 1278 Step A：claw daemon 状态提示 formatter 归位 CLIProtocol
 * （迁自 `src/cli/utils/claw-status-hints.ts` phase 540/708，文本与分支逐字不变）。
 *
 * 职责：拥有「目标 claw 未运行」提示文案与真实 CLI 命令字面
 * `chestnut claw <id> daemon`（M#1/M#2：真实命令语言与操作提示唯一归 CLIProtocol）。
 *
 * 应然边界：
 * - 纯 formatter：存活事实由调用方以 boolean 传入，不 import ProcessManager；
 * - 零实现依赖：不 import CLIProcess / Assembly（M#5、dependency-cruiser ratchet 守）；
 * - 消费方（Assembly 装配 notify_claw / CLIProcess claw send）只经 public barrel 取得。
 */

/**
 * Format a hint message for caller when target claw is not running.
 *
 * @returns hint string with restart instruction, or undefined if claw is alive.
 * @example
 *   formatClawStatusHint('my-claw', false)
 *     === 'Note: claw "my-claw" is not running. Start it with: chestnut claw my-claw daemon'
 *   formatClawStatusHint('my-claw', true) === undefined
 */
export function formatClawStatusHint(clawName: string, isAlive: boolean): string | undefined {
  if (isAlive) return undefined;
  return `Note: claw "${clawName}" is not running. Start it with: chestnut claw ${clawName} daemon`;
}
