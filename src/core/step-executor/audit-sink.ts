/**
 * @module L3.StepExecutor.AuditSink
 * phase 1857 Step D (SE-D3): StepInput 审计注入收窄为最小事件 sink。
 *
 * StepExecutor 只消费 write/message/preview 三方法（结构类型）；
 * 真 AuditLog（foundation/audit）结构满足本接口 → Assembly/caller 零显式适配。
 * 签名逐字对齐 foundation/audit/types.ts 的 AuditLog 对应方法。
 * owner 内部类型，不进 barrel（同 PM sink 惯例）。
 */

export interface StepExecutorAuditSink {
  write(event: string, ...details: (string | number)[]): void;
  /** Truncate s to AUDIT_MESSAGE_MAX_CHARS (200) — mid context, error / reason / command. */
  message(s: string): string;
  /** Truncate s to AUDIT_PREVIEW_LEN (100) — short raw preview, "glance" level. */
  preview(s: string): string;
}
