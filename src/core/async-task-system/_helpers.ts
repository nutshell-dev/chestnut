/**
 * @module L4.AsyncTaskSystem.Helpers
 * Module-level error format + audit helpers for async-task-system.
 *
 * Pattern：phase 572 contract acceptance / phase 588 runtime helper 模板复用扩 async-task-system。
 * 字段约定：error=（与 contract 一致 / vs runtime 用 reason=）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';

export function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function auditError(
  audit: AuditLog,
  event: string,
  err: unknown,
  ...extras: string[]
): void {
  audit.write(event, ...extras, `error=${formatErr(err)}`);
}
