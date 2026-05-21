/**
 * @module L4.AsyncTaskSystem.Helpers
 * Module-level error format + audit helpers for async-task-system.
 *
 * Pattern：phase 572 contract acceptance / phase 588 runtime helper 模板复用扩 async-task-system。
 * 字段约定：error=（与 contract 一致 / vs runtime 用 reason=）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/utils/format.js';
export { formatErr };

export function auditError(
  audit: AuditLog,
  event: string,
  err: unknown,
  ...extras: string[]
): void {
  audit.write(event, ...extras, `error=${formatErr(err)}`);
}

export function classifyTaskError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'abort';
    if (err.name === 'ToolTimeoutError') return 'tool_timeout';
    if (err.name === 'LLMTimeoutError') return 'llm_timeout';
    if (err.name === 'LLMRateLimitError') return 'rate_limit';
    if (err.name === 'LLMAuthError') return 'auth';
    if (err.name === 'LLMNetworkError') return 'network';
    return err.name || 'error';
  }
  return 'unknown';
}
