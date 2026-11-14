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
 * - 纯 formatter：调用方传入结构化 liveness kind，不 import ProcessManager；
 * - 零实现依赖：不 import CLIProcess / Assembly（M#5、dependency-cruiser ratchet 守）；
 * - 消费方（Assembly 装配 notify_claw / CLIProcess claw send）只经 public barrel 取得。
 */

/**
 * Format a hint message for caller when target claw is not running.
 *
 * @returns restart hint only for confirmed dead/absent; alive and unknown states return undefined.
 */
type ClawStatusHintLiveness = {
  kind: 'alive' | 'dead' | 'absent' | 'malformed' | 'probe_unavailable';
};

export function formatClawStatusHint(
  clawName: string,
  liveness: ClawStatusHintLiveness,
): string | undefined {
  // malformed/probe_unavailable 是 unknown，不得伪装成 not running。
  if (liveness.kind !== 'dead' && liveness.kind !== 'absent') return undefined;
  return `Note: claw "${clawName}" is not running. Start it with: chestnut claw ${clawName} daemon`;
}
