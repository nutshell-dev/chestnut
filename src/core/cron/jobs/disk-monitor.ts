import * as path from 'path';
import type { FileSystem } from '../../../foundation/fs/types.js';
import { InboxWriter } from '../../../foundation/messaging/index.js';
import { AuditWriter } from '../../../foundation/audit/index.js';

/** 递归计算目录大小（bytes） */
function getDirSize(dir: string, fs: FileSystem): number {
  let size = 0;
  for (const entry of fs.listSync(dir, { includeDirs: true })) {
    if (entry.isDirectory) {
      size += getDirSize(path.join(dir, entry.name), fs);
    } else {
      size += entry.size;
    }
  }
  return size;
}

export interface DiskMonitorOptions {
  clawforumDir: string;   // .clawforum/ 根目录
  motionInboxDir: string; // motion/inbox/pending/
  limitMB: number;        // 告警阈值
  fs: FileSystem;
}

export async function runDiskMonitor(opts: DiskMonitorOptions): Promise<void> {
  const clawsDir = path.join(opts.clawforumDir, 'claws');
  if (!opts.fs.existsSync(clawsDir)) return;

  let totalSize = 0;
  for (const clawId of opts.fs.listSync(clawsDir, { includeDirs: true }).map(e => e.name)) {
    const clawspaceDir = path.join(clawsDir, clawId, 'clawspace');
    if (opts.fs.existsSync(clawspaceDir)) {
      totalSize += getDirSize(clawspaceDir, opts.fs);
    }
  }

  const totalMB = Math.round(totalSize / 1024 / 1024);
  console.log(`[cron:disk-monitor] ${totalMB}MB / ${opts.limitMB}MB`);

  if (totalMB > opts.limitMB) {
    console.warn(`[cron:disk-monitor] WARNING: usage ${totalMB}MB > limit ${opts.limitMB}MB`);
    const motionAudit = new AuditWriter(opts.fs, path.join(opts.motionInboxDir, '..', '..', 'audit.tsv'));
    new InboxWriter(opts.fs, opts.motionInboxDir, motionAudit).writeSync({
      type: 'cron_disk_warning',
      source: 'cron',
      priority: 'high',
      body: `Disk usage ${totalMB}MB, limit ${opts.limitMB}MB`,
      idPrefix: `${Date.now()}_disk_warning`,
      filenameTag: 'disk_warning',
    });
  }
}
