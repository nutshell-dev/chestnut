/**
 * @module Core.ClawId
 * phase 204: ClawId brand type — M#9 推广至 ID 维度。
 *
 * Rationale: 多 sibling ID 已 branded（11 unique-symbol brand: ContractId / SubtaskId /
 * TaskId / TraceId / ToolUseId / ArchiveDir / ChestnutRoot / StepNumber / OutboxPath /
 * InboxPath / ProcessStartTime + 3 string-literal brand: AuditLog / AuditReader / TraceId）、
 * 唯 ClawId 是 plain `string`。本 phase 立 infrastructure、follow-up
 * phases module-by-module 渐进迁移 120+ `clawId: string` 现有 site。
 *
 * Pattern: 沿用 ContractId pattern（src/core/contract/types.ts:12-14）：
 *
 *   declare const Brand: unique symbol;
 *   export type X = string & { readonly [Brand]: true };
 *   export function makeX(s: string): X { return s as X; }
 *
 * 用法：
 *
 *   // module 定义 + 内部使用
 *   function readClawDir(clawId: ClawId): ClawDir { ... }
 *
 *   // boundary 处转换（yaml parse / disk dir name / CLI args / audit.tsv 解析）
 *   const rawId: string = yamlConfig.claw_id;
 *   const clawId: ClawId = makeClawId(rawId);
 *   readClawDir(clawId);
 *
 *   // ClawId IS-A string、隐式 ClawId → string 合法
 *   const path = `/var/claws/${clawId}`;  // OK
 *
 *   // string → ClawId 必须 makeClawId（防 caller 误传任意 string）
 *   readClawDir('arbitrary-string');  // TS error
 *   readClawDir(makeClawId('cli-auditor'));  // OK
 */

declare const ClawIdBrand: unique symbol;

export type ClawId = string & { readonly [ClawIdBrand]: true };

export function makeClawId(s: string): ClawId {
  return s as ClawId;
}
