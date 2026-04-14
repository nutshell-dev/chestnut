/**
 * Dialog module
 * Session management re-exported from SessionStore (L2).
 * Context injection remains in core/dialog.
 */

// Re-export from new location (backward compat)
export { SessionManager } from '../../foundation/session-store/index.js';
export type { SessionData } from '../../foundation/session-store/index.js';

// Context injection stays here
export { ContextInjector } from './injector.js';
