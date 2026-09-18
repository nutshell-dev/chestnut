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
// phase 1861 (CM-D9): contract input types — explicit barrel surface (types only).
export type { MaybeTrimProactiveInputs } from './maybe-trim-proactive.js';
export {
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_TARGET_RATIO,
  REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
  CONTEXT_TRIM_PREVIEW_BYTES,
  CACHE_TTL_MS,
} from './constants.js';
export type { TrimRuntimePolicy } from './constants.js';
export {
  buildReactiveTrimPolicy,

  type ContextTrimOutcome,
  type TrimPolicy,
  type TrimV2Options,
  type AuditWriter,
} from './trim-v2.js';

export {
  trimAndPersist,
  type TrimAndPersistInputs,
  type DialogStoreMutationCapability,
  type TriggerKind,
} from './trim-and-persist.js';
export {
  ContextTrimExhaustedError,
  ContextTrimPersistError,
  type ContextTrimExhaustedEvidence,
  type ContextTrimPersistStage,
} from './errors.js';
