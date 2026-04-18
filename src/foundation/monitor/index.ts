/**
 * Monitor module (F3)
 * Phase 0: Interface definition + JSONL implementation
 * 
 * Exports: Logger interface, JsonlLogger implementation
 * 
 * Note: Monitor has been slimmed down. LLM/Tool/Contract events
 * are now tracked in audit.tsv. This module is only for internal
 * error logging and debugging.
 */

// Types and interfaces
export type {
  LogEvent,
  Logger,
} from './types.js';

// Implementation
export { JsonlLogger } from './monitor.js';
export type { JsonlLoggerOptions } from './monitor.js';

// JSONL utilities
export { appendJsonl, readJsonl } from './jsonl.js';
