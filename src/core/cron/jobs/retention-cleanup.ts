import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';

export interface RetentionCleanupOptions {
  motionDir: string;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: {
    inbox?: number;
    outbox?: number;
    tasks?: number;
    dialog?: number;
  };
}

const DIRS: Array<{ relPath: string; maxDaysKey: keyof RetentionCleanupOptions['maxDays'] }> = [
  { relPath: 'inbox/done', maxDaysKey: 'inbox' },
  { relPath: 'inbox/failed', maxDaysKey: 'inbox' },
  { relPath: 'outbox/done', maxDaysKey: 'outbox' },
  { relPath: 'outbox/failed', maxDaysKey: 'outbox' },
  { relPath: 'tasks/done', maxDaysKey: 'tasks' },
  { relPath: 'tasks/failed', maxDaysKey: 'tasks' },
  { relPath: 'tasks/results', maxDaysKey: 'tasks' },
];

export async function runRetentionCleanup(opts: RetentionCleanupOptions): Promise<void> {
  const { motionDir, fs, audit, maxDays } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  for (const { relPath, maxDaysKey } of DIRS) {
    const maxD = maxDays[maxDaysKey];
    if (!maxD) continue;

    const dir = path.join(motionDir, relPath);
    if (!fs.existsSync(dir)) continue;

    const cutoff = now - maxD * 24 * 60 * 60 * 1000;
    try {
      for (const entry of fs.listSync(dir)) {
        if (entry.isDirectory) continue;
        try {
          const stats = fs.statSync(path.join(dir, entry.name));
          if (stats.mtime.getTime() < cutoff) {
            fs.deleteSync(path.join(dir, entry.name));
            totalDeleted++;
          }
        } catch (err) {
          audit.write(CRON_AUDIT_EVENTS.RETENTION_CLEANUP_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      audit.write(CRON_AUDIT_EVENTS.RETENTION_CLEANUP_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  audit.write(CRON_AUDIT_EVENTS.RETENTION_CLEANUP, `deleted=${totalDeleted}`);
}
