import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import type { InboxWriter } from '../../../foundation/messaging/index.js';
import { CLAWSPACE_DIR, CLAWS_DIR } from '../../../foundation/paths.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const DISK_MONITOR_CRON_TIMEOUT_MS = 60_000;

/** 递归计算目录大小（bytes） */
function getDirSize(dir: string, fs: FileSystem, audit?: AuditLog, signal?: AbortSignal): number {
  try {
    let size = 0;
    for (const entry of fs.listSync(dir, { includeDirs: true })) {
      if (signal?.aborted) return size;
      if (entry.isDirectory) {
        size += getDirSize(path.join(dir, entry.name), fs, audit, signal);
      } else {
        size += entry.size;
      }
    }
    return size;
  } catch (err) {
    audit?.write(
      CRON_AUDIT_EVENTS.DISK_MONITOR_CHECK,
      `step=scan_failed`,
      `dir=${dir}`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return 0; // partial scan / best-effort
  }
}

export interface DiskMonitorOptions {
  clawforumDir: string;   // .clawforum/ 根目录
  limitMB: number;        // 告警阈值
  fs: FileSystem;
  audit: AuditLog;
  motionAudit: AuditLog;   // motion-side audit (装配方预 build)
  motionInbox: InboxWriter; // motion inbox writer (装配方预 build)
  signal?: AbortSignal;
}

export async function runDiskMonitor(opts: DiskMonitorOptions): Promise<void> {
  const clawsDir = path.join(opts.clawforumDir, CLAWS_DIR);
  if (!opts.fs.existsSync(clawsDir)) return;

  let totalSize = 0;
  for (const clawId of opts.fs.listSync(clawsDir, { includeDirs: true }).map(e => e.name)) {
    if (opts.signal?.aborted) return;
    const clawspaceDir = path.join(clawsDir, clawId, CLAWSPACE_DIR);
    if (opts.fs.existsSync(clawspaceDir)) {
      totalSize += getDirSize(clawspaceDir, opts.fs, opts.audit, opts.signal);
    }
  }

  const totalMB = Math.round(totalSize / 1024 / 1024);
  opts.audit.write(CRON_AUDIT_EVENTS.DISK_MONITOR_CHECK, `totalMB=${totalMB}`, `limitMB=${opts.limitMB}`);

  if (totalMB > opts.limitMB) {
    opts.audit.write(CRON_AUDIT_EVENTS.DISK_MONITOR_THRESHOLD_EXCEEDED, `totalMB=${totalMB}`, `limitMB=${opts.limitMB}`);
    opts.motionInbox.writeSync({
      type: 'cron_disk_warning',
      source: 'cron',
      priority: 'high',
      body: `Disk usage ${totalMB}MB, limit ${opts.limitMB}MB`,
      idPrefix: `${Date.now()}_disk_warning`,
    });
  }
}
