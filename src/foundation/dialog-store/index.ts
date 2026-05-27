/**
 * @module L2.DialogStore
 * DialogStore module (L2)
 *
 * Messages array persistence. Serves crash-recoverable sessions.
 * Dependency: FileSystem
 */

export { DialogStore, MarkerNotFoundError, migrateAndValidateSession, validateSessionData } from './store.js';
export type { SessionData, LoadResult, DialogMarker, RestoreResult } from './types.js';

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

import * as path from 'path';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import { type ClawDir } from '../identity/index.js';

export async function cleanupArchives(opts: {
  motionDir: ClawDir;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { motionDir, fs, audit, maxDays, signal } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  const dir = path.join(motionDir, 'dialog/archive');
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
        audit.write(DIALOG_AUDIT_EVENTS.CLEANUP_ARCHIVES_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    audit.write(DIALOG_AUDIT_EVENTS.CLEANUP_ARCHIVES_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${err instanceof Error ? err.message : String(err)}`);
  }

  return totalDeleted;
}
