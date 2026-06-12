/**
 * @module L4.ContextManager
 * Barrel export — 4 sub-capabilities: trim / budget / exceeded / errors + audit events
 *
 * phase 277: handoff sub-capability removed (dead subsystem cleanup per drift-backlog
 * B.phase197-context-manager-handoff-src-cleanup ratify scope)
 */

export { trim, type TrimOptions, type TrimResult } from './trim.js';
export { computeBudget, type BudgetInputs, type BudgetResult } from './budget.js';
export { handleContextExceeded, type LLMCallView } from './exceeded.js';
export { ContextTrimExhaustedError } from './errors.js';
export * as AUDIT from './audit-events.js';
