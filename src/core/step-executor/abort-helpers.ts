/**
 * Abort signal handling utilities for the React loop.
 *
 * phase 1857 Step B (SE-D1): 控制信号（idle_timeout / step_yield / user）不再以
 * 三个独立 class 表达。StepExecutor 只消费最小、稳定的 abort reason 数据协议
 * （StepAbortReason 判别联合），经单一载体 StepAbortError 抛出；
 * 上层（runtime / event-loop / subagent）按 reason.kind 数据判据消费，
 * 展示语义各自本地。abort 触发点的 reason 载荷字面（{type, ms}）不变。
 */

import { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';

/** StepExecutor 的最小 abort reason 数据协议（判别联合，数据化）。 */
export type StepAbortReason =
  | { kind: 'idle_timeout'; ms: number }
  | { kind: 'step_yield' }
  | { kind: 'user_interrupt' };

/** abort 单一载体：携带 StepAbortReason 数据协议。 */
export class StepAbortError extends Error {
  readonly reason: StepAbortReason;

  constructor(reason: StepAbortReason) {
    super(`step aborted: ${reason.kind}`);
    this.name = 'StepAbortError';
    this.reason = reason;
  }
}

export function isStepAbortError(err: unknown): err is StepAbortError {
  return err instanceof StepAbortError;
}

export function throwAbortError(signal: AbortSignal, auditWriter?: { write: (...args: string[]) => void }): never {
  const r = signal.reason as { type?: string; ms?: number } | undefined;
  if (r?.type === 'idle_timeout') throw new StepAbortError({ kind: 'idle_timeout', ms: r.ms ?? 0 });
  if (r?.type === 'step_yield')   throw new StepAbortError({ kind: 'step_yield' });
  if (r?.type === 'user')         throw new StepAbortError({ kind: 'user_interrupt' });
  const violationMsg = `Execution aborted (unexpected reason: ${JSON.stringify(r)})`;
  auditWriter?.write(
    STEP_EXECUTOR_AUDIT_EVENTS.INVARIANT_VIOLATION,
    `site=abort-helpers.ts:12`,
    `kind=unexpected_abort_reason`,
    `reason=${JSON.stringify(r)}`,
    `msg=${violationMsg}`,
  );
  throw new Error(`[INVARIANT VIOLATION] step-executor: ${violationMsg}`);
}
