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

} from './maybe-trim-proactive.js';
export {
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
} from './constants.js';
export {
  buildReactiveTrimPolicy,

  type ContextTrimOutcome,
} from './trim-v2.js';

export { createContextInjector, ContextInjector } from './injector.js';
export { trimAndPersist } from './trim-and-persist.js';
export { ContextTrimExhaustedError } from './errors.js';
