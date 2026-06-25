/**
 * @module L4.ContextManager
 * Barrel export — phase 440 context-trim pipeline + errors/audit events.
 *
 * phase 440 Step D: removed legacy trim.ts / exceeded.ts; new trim-v2 pipeline is the
 * single production path for context-window overflow handling.
 * phase 516: removed legacy budget.ts (computeBudget helper unused after phase 440 Step C
 * — all callers inline target formula directly).
 */

export {
  maybeTrimProactive,
  type MaybeTrimProactiveInputs,
} from './maybe-trim-proactive.js';
export {
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_TARGET_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
} from './constants.js';

// phase 685: ContextInjector 合并自 core/dialog 成为 ContextManager 子模块（physical merge）、
// 但 barrel 不 re-export — 走 barrel 会拉 injector → contract barrel → ... → step-executor →
// l4_context_manager/index → injector 闭环（depcruise no-circular 触发）。
// caller 走 deep import from './injector.js' 叶子（同型 phase 397/phase 1312 防环 ratify）。
