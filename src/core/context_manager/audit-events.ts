/**
 * @module L4.ContextManager
 * ContextManager audit events — 3 consts for audit sink emission
 */

export const CONTEXT_TRIM_STARTED = 'context_trim_started';
export const CONTEXT_TRIM_COMPLETED = 'context_trim_completed';
export const CONTEXT_TRIM_ARCHIVED = 'context_trim_archived';   // ← NEW phase 440
/** phase 1861 (CM-D3)：trim 失败事实（stage=invalid_progress|archive|save）。 */
export const CONTEXT_TRIM_FAILED = 'context_trim_failed';
