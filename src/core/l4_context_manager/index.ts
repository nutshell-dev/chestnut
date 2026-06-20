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
  trimAndPersist,
  type TrimAndPersistInputs,
  type TrimAndPersistResult,
} from './trim-and-persist.js';
export {
  maybeTrimProactive,
  type MaybeTrimProactiveInputs,
} from './maybe-trim-proactive.js';
export { trimV2, type TrimV2Options, type TrimV2Result } from './trim-v2.js';
export { ContextTrimExhaustedError } from './errors.js';
export {
  CACHE_TTL_MS,
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_TARGET_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
} from './constants.js';
export * as AUDIT from './audit-events.js';
