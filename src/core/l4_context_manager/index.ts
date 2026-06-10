/**
 * @module L4.ContextManager
 * Barrel export — 5 sub-capabilities: trim / budget / handoff / exceeded / errors + audit events
 */

export { trim, type TrimOptions, type TrimResult } from './trim.js';
export { computeBudget, type BudgetInputs, type BudgetResult } from './budget.js';
export {
  createHandoffMarker,
  resolveHandoffMarker,
  type HandoffMarker,
} from './handoff.js';
export { handleContextExceeded, type LLMCallView } from './exceeded.js';
export {
  ContextTrimExhaustedError,
  ContextTrimInsufficientWithoutCacheBreakError,
} from './errors.js';
export * as AUDIT from './audit-events.js';
