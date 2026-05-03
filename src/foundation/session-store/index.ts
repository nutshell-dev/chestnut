/**
 * @module L2.SessionStore
 * SessionStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { SessionManager } from './store.js';
export type { SessionData, LoadResult } from './types.js';

import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { SessionManager } from './store.js';

export function createSessionManager(
  fs: FileSystem,
  dialogDir: string,
  audit: AuditLog,
  clawId: string,
): SessionManager {
  return new SessionManager(fs, dialogDir, audit, clawId);
}
