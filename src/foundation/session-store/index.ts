/**
 * SessionStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { SessionManager } from './store.js';
export type { SessionData, LoadResult } from './types.js';
