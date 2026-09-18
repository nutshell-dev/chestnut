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
  /**
   * phase 1857 Step G (SE-D7): 工具执行批内 abort 时的提交证据——
   * 「已执行未提交」可区分于「未执行」；identity + 成功位，不缓存结果正文。
   */
  readonly evidence?: AbortExecutionEvidence;

  constructor(reason: StepAbortReason, evidence?: AbortExecutionEvidence) {
    super(`step aborted: ${reason.kind}`);
    this.name = 'StepAbortError';
    this.reason = reason;
    this.evidence = evidence;
  }
}

/** 工具执行批内已完成结果的提交证据（SE-D7）。 */
export interface AbortExecutionEvidence {
  completed: Array<{ toolName: string; toolUseId: string; success: boolean }>;
}

export function isStepAbortError(err: unknown): err is StepAbortError {
  return err instanceof StepAbortError;
}

/**
 * phase 1857 Step G (SE-D7): 中断 audit 行的 evidence 摘要列（无证据/空证据 → 空数组，零漂移）。
 * 列扩展登记：completed_tools=<n> + completed_tool_summary=<name>#<id>:ok|fail,...（防列爆炸摘要形式）。
 */
export function abortEvidenceAuditCols(err: unknown): string[] {
  if (!isStepAbortError(err) || !err.evidence || err.evidence.completed.length === 0) return [];
  return [
    `completed_tools=${err.evidence.completed.length}`,
    `completed_tool_summary=${err.evidence.completed.map(c => `${c.toolName}#${c.toolUseId}:${c.success ? 'ok' : 'fail'}`).join(',')}`,
  ];
}

export function throwAbortError(
  signal: AbortSignal,
  auditWriter?: { write: (...args: string[]) => void },
  evidence?: AbortExecutionEvidence,
): never {
  const r = signal.reason as { type?: string; ms?: number } | undefined;
  if (r?.type === 'idle_timeout') throw new StepAbortError({ kind: 'idle_timeout', ms: r.ms ?? 0 }, evidence);
  if (r?.type === 'step_yield')   throw new StepAbortError({ kind: 'step_yield' }, evidence);
  if (r?.type === 'user')         throw new StepAbortError({ kind: 'user_interrupt' }, evidence);
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
