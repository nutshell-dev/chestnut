/**
 * @module L2.DialogStore
 * DialogStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { DialogStore } from './store.js';
export type { SessionData, LoadResult } from './types.js';

import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { DialogStore } from './store.js';

export function createDialogStore(
  fs: FileSystem,
  dialogDir: string,
  audit: AuditLog,
  filename: string,                       // phase 450: 必填
  clawId?: string,                        // phase 450: 可选
  archiveDir?: string,                    // phase 450: 可选
): DialogStore {
  return new DialogStore(fs, dialogDir, audit, filename, clawId, archiveDir);
}
