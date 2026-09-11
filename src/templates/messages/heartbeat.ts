/**
 * M08 inbox 文案：heartbeat 常规检查（base 行 + 已读 checklist 组合）。
 * 触发/接收者：Heartbeat 定时 → 本 claw inbox（heartbeat）。
 * 原 owner：core/heartbeat（读 HEARTBEAT.md、ENOENT/错误分支仍归 owner）。
 */

export function heartbeatBaseLine(timestampSec: number | string): string {
  return `[system message${timestampSec}] Heartbeat triggered. Please perform a routine check.`;
}

export function heartbeatWithChecklist(timestampSec: number | string, checklist: string): string {
  return `${heartbeatBaseLine(timestampSec)}\n\n${checklist}`;
}
