/**
 * @module L3.ContextInjector
 * Dialog module
 * Session management re-exported from SessionStore (L2).
 * Context injection remains in core/dialog.
 */

// Re-export from new location (backward compat)
export { DialogStore } from '../../foundation/dialog-store/index.js';
export type { SessionData } from '../../foundation/dialog-store/index.js';

// Context injection stays here
export { ContextInjector, createContextInjector } from './injector.js';
