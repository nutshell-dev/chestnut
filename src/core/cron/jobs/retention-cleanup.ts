import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { cleanupRetention } from '../../../foundation/messaging/index.js';
import { INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../../foundation/messaging/dirs.js';
import { cleanupTaskRetention } from '../../async-task-system/index.js';
import { cleanupArchives } from '../../../foundation/dialog-store/index.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const RETENTION_CLEANUP_CRON_TIMEOUT_MS = 120_000;

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
  signal?: AbortSignal;
}

const DIRS: Array<{ relPath: string; maxDaysKey: keyof RetentionCleanupOptions['maxDays'] }> = [
  { relPath: INBOX_DONE_DIR, maxDaysKey: 'inbox' },
  { relPath: INBOX_FAILED_DIR, maxDaysKey: 'inbox' },
  { relPath: 'outbox/done', maxDaysKey: 'outbox' },
  { relPath: 'outbox/failed', maxDaysKey: 'outbox' },
  { relPath: 'tasks/done', maxDaysKey: 'tasks' },
  { relPath: 'tasks/failed', maxDaysKey: 'tasks' },
  { relPath: 'tasks/results', maxDaysKey: 'tasks' },
  { relPath: 'dialog/archive', maxDaysKey: 'dialog' },
];

export async function runRetentionCleanup(opts: RetentionCleanupOptions): Promise<void> {
  void DIRS; // kept for reference during refactor
  const { motionDir, fs, audit, maxDays, signal } = opts;

  let totalDeleted = 0;

  totalDeleted += await cleanupRetention({ motionDir, fs, audit, maxDays, signal });

  if (!signal?.aborted && maxDays.tasks) {
    totalDeleted += await cleanupTaskRetention({ motionDir, fs, audit, maxDays: maxDays.tasks, signal });
  }

  if (!signal?.aborted && maxDays.dialog) {
    totalDeleted += await cleanupArchives({ motionDir, fs, audit, maxDays: maxDays.dialog, signal });
  }

  audit.write(CRON_AUDIT_EVENTS.RETENTION_CLEANUP, `deleted=${totalDeleted}`);
}
