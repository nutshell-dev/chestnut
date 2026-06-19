/**
 * @module L2.DialogStore
 * DialogStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { DialogStore } from './store.js';
export { MarkerNotFoundError, migrateAndValidateSession, validateSessionData } from './validate.js';
export type { SessionData } from './types.js';
// phase 1406: regime switch 业务（dialog 资源重组）从 Runtime 迁入 DialogStore module
export { performRegimeSwitch } from './regime-switch.js';
export type { PerformRegimeSwitchOpts } from './regime-switch.js';

// phase 1432 F6: dirs path const re-export — 跨模块 (cli) 路径合成走 barrel。
// allowlist: assembly/assemble.ts (装配根 bootstrap by-design)。
export { DIALOG_DIR, DIALOG_ARCHIVE_DIR, CURRENT_DIALOG_FILE } from './dirs.js';

// phase 147 Step B: lookup helper + 4 级降级路径
export {
  lookupContentByToolUseId,
} from './lookup.js';
export type {
  LookupResult,
  LookupOptions,
} from './lookup.js';

import type { FileSystem } from '../fs/types.js';
import { formatErr } from "../utils/index.js";
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

import * as path from 'path';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import { DIALOG_ARCHIVE_DIR } from './dirs.js';

export async function cleanupArchives(opts: {
  motionDir: string;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { motionDir, fs, audit, maxDays, signal } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  const dir = path.join(motionDir, DIALOG_ARCHIVE_DIR);
  if (!fs.existsSync(dir)) return 0;

  const cutoff = now - maxDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.listSync(dir)) {
      if (signal?.aborted) break;
      if (entry.isDirectory) continue;
      try {
        const stats = fs.statSync(path.join(dir, entry.name));
        if (stats.mtime.getTime() < cutoff) {
          fs.deleteSync(path.join(dir, entry.name));
          totalDeleted++;
        }
      } catch (err) {
        audit.write(DIALOG_AUDIT_EVENTS.CLEANUP_ARCHIVES_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${formatErr(err)}`);
      }
    }
  } catch (err) {
    audit.write(DIALOG_AUDIT_EVENTS.CLEANUP_ARCHIVES_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${formatErr(err)}`);
  }

  return totalDeleted;
}
