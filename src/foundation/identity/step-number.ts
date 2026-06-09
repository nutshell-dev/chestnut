/**
 * StepNumber brand type (phase 216 立、phase 136 §5.B invariants 第 6 条).
 *
 * SoT: agent-executor (`agent-executor.ts:56,68,75`、let stepCount counter + ctx.stepNumber assign)
 * 形态: integer ≥ 0（agent loop step counter、ReAct 步数）
 *
 * Invariants:
 * - 模块外不可造（__brand 编译期 check）
 * - runtime 等价 number（audit emit 字面不变、M#7 + 跨进程契约 / `step=<integer>` 形态保）
 * - factory 输入 NaN / Infinity / negative / non-number → throw（编码规范错误段）
 */

declare const StepNumberBrand: unique symbol;
export type StepNumber = number & { readonly [StepNumberBrand]: true };

export function makeStepNumber(n: number): StepNumber {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`makeStepNumber: expected non-negative integer, got ${n} (${typeof n})`);
  }
  return n as StepNumber;
}
