/**
 * @module L2b.DialogStore
 * DialogStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { DialogStore } from './store.js';
// phase 483: audit-events barrel re-export
export { DIALOG_AUDIT_EVENTS } from './audit-events.js';
export { MarkerNotFoundError, migrateAndValidateSession, validateSessionData } from './validate.js';
export type { SessionData } from './types.js';
// phase 1406: regime switch 业务（dialog 资源重组）从 Runtime 迁入 DialogStore module
export { performRegimeSwitch } from './regime-switch.js';
export type { PerformRegimeSwitchOpts } from './regime-switch.js';

// phase 1432 F6: dirs path const re-export — 跨模块 (cli) 路径合成走 barrel。
// allowlist: assembly/assemble.ts (装配根 bootstrap by-design)。
export { DIALOG_DIR, DIALOG_ARCHIVE_DIR, CURRENT_DIALOG_FILE } from './dirs.js';

// phase 751-752: lightweight archive listing
export { listArchiveDialogFiles } from './list-archive.js';
export type { ArchiveDialogRef } from './list-archive.js';

// phase 147 Step B: lookup helper + 4 级降级路径
export {
  lookupContentByToolUseId,
} from './lookup.js';
export type {
  LookupResult,
  LookupOptions,
} from './lookup.js';

import type { FileSystem } from '../fs/index.js';
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


