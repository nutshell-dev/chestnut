/**
 * M01 inbox 文案：execution_recovery 停滞恢复投递。
 * 触发/接收者：EventLoop 停滞恢复 → 本 claw 自家 inbox（高优）。
 * 原 owner：core/event-loop。
 */

export function executionRecoveryMessage(contractId: string, attempts: number): string {
  return `Execution stalled with no persisted activity; resume work on active contract ${contractId} (recovery attempt ${attempts}).`;
}
