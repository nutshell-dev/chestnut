import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import { cleanupRetention } from '../../../foundation/messaging/index.js';
// INBOX_DONE_DIR / INBOX_FAILED_DIR removed with DIRS (Phase 28 Step B)
import { cleanupExpiredTaskFiles } from '../../async-task-system/index.js';
import { cleanupArchives } from '../../../foundation/dialog-store/index.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';

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

export interface RetentionCleanupJobDeps {
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

export async function runRetentionCleanup(opts: RetentionCleanupOptions): Promise<void> {
  const { motionDir, fs, audit, maxDays, signal } = opts;

  let totalDeleted = 0;

  totalDeleted += await cleanupRetention({ motionDir, fs, audit, maxDays, signal });

  if (!signal?.aborted && maxDays.tasks) {
    totalDeleted += await cleanupExpiredTaskFiles({ motionDir, fs, audit, maxDays: maxDays.tasks, signal });
  }

  if (!signal?.aborted && maxDays.dialog) {
    totalDeleted += await cleanupArchives({ motionDir, fs, audit, maxDays: maxDays.dialog, signal });
  }

  audit.write(CRON_AUDIT_EVENTS.RETENTION_CLEANUP, `deleted=${totalDeleted}`);
}

export function createRetentionCleanupJob(
  deps: RetentionCleanupJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'retention-cleanup',
    enabled: globalConfig.cron.jobs.retention_cleanup.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.retention_cleanup.schedule, deps.audit),
    handler: (signal) => runRetentionCleanup({ ...deps, signal }),
    timeoutMs: RETENTION_CLEANUP_CRON_TIMEOUT_MS,
  };
}
