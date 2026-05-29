/**
 * @module L2.Messaging.RetentionCleanup
 * phase 1428: 抽自 index.ts ML#1 SRP — barrel 不持 impl
 */

import * as path from 'path';
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { type ClawDir } from '../identity/index.js';
import { INBOX_DONE_DIR, INBOX_FAILED_DIR } from './dirs.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import { emitOutboxProcessingOrphanCleaned } from './audit-emit.js';

export async function cleanupRetention(opts: {
  motionDir: ClawDir;
  fs: FileSystem;
  audit: AuditLog;
  maxDays: { inbox?: number; outbox?: number };
  signal?: AbortSignal;
}): Promise<number> {
  const { motionDir, fs, audit, maxDays, signal } = opts;
  const now = Date.now();
  let totalDeleted = 0;

  const dirs: Array<{ relPath: string; maxDaysKey: 'inbox' | 'outbox' }> = [
    { relPath: INBOX_DONE_DIR, maxDaysKey: 'inbox' },
    { relPath: INBOX_FAILED_DIR, maxDaysKey: 'inbox' },
    { relPath: 'outbox/done', maxDaysKey: 'outbox' },
    { relPath: 'outbox/failed', maxDaysKey: 'outbox' },
    { relPath: 'outbox/processing', maxDaysKey: 'outbox' },
  ];

  for (const { relPath, maxDaysKey } of dirs) {
    if (signal?.aborted) break;
    const maxD = maxDays[maxDaysKey];
    if (!maxD) continue;

    const dir = path.join(motionDir, relPath);
    if (!fs.existsSync(dir)) continue;

    const cutoff = now - maxD * 24 * 60 * 60 * 1000;
    let dirDeleted = 0;
    try {
      for (const entry of fs.listSync(dir)) {
        if (signal?.aborted) break;
        if (entry.isDirectory) continue;
        try {
          const stats = fs.statSync(path.join(dir, entry.name));
          if (stats.mtime.getTime() < cutoff) {
            fs.deleteSync(path.join(dir, entry.name));
            totalDeleted++;
            dirDeleted++;
          }
        } catch (err) {
          audit.write(MESSAGING_AUDIT_EVENTS.RETENTION_CLEANUP_DELETE_FAILED, `context=per-file`, `dir=${dir}`, `file=${entry.name}`, `reason=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      audit.write(MESSAGING_AUDIT_EVENTS.RETENTION_CLEANUP_DELETE_FAILED, `context=per-dir`, `dir=${dir}`, `reason=${err instanceof Error ? err.message : String(err)}`);
    }

    if (relPath === 'outbox/processing' && dirDeleted > 0) {
      emitOutboxProcessingOrphanCleaned(audit, { count: dirDeleted });
    }
  }

  return totalDeleted;
}
