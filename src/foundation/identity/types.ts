/**
 * @module L2.Identity (foundation 层 cross-module ID 类型 own)
 * phase 1358：ClawId 跨 module 概念、归 foundation 层 own (per ML#3 资源唯一归属)
 */

declare const ClawIdBrand: unique symbol;
export type ClawId = string & { readonly [ClawIdBrand]: true };
export function makeClawId(s: string): ClawId { return s as ClawId; }

// NEW phase 1365 r-phase1365: TaskId 物理迁自 core/async-task-system/types.ts
// per ML#3 资源唯一归属 + phase 1358 ID branding ClawId 模板 mirror
declare const TaskIdBrand: unique symbol;
export type TaskId = string & { readonly [TaskIdBrand]: true };
export function makeTaskId(s: string): TaskId { return s as TaskId; }
