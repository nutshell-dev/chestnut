/**
 * M02 inbox 文案：startup_check 启动自检通知。
 * 触发/接收者：daemon 启动（冷却 + 空 inbox + 有活跃契约）→ 本 claw inbox（高优）。
 * 原 owner：daemon。
 */

export function startupCheckMessage(): string {
  return 'System startup. Please review active contracts and resume execution.';
}
