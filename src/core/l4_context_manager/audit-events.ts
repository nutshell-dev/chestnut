/**
 * @module L4.ContextManager
 * ContextManager audit events — 7 consts for audit sink emission
 */

export const CONTEXT_TRIM_STARTED = 'context_trim_started';
export const CONTEXT_TRIM_COMPLETED = 'context_trim_completed';
export const CONTEXT_TRIM_EXHAUSTED = 'context_trim_exhausted';
export const CONTEXT_TRIM_INSUFFICIENT_WITHOUT_CACHE_BREAK = 'context_trim_insufficient_without_cache_break';
export const CACHE_INVALIDATED_BY_DEEP_TRIM = 'cache_invalidated_by_deep_trim';
export const HANDOFF_MARKER_CREATED = 'handoff_marker_created';
export const HANDOFF_MARKER_NOT_FOUND = 'handoff_marker_not_found';
