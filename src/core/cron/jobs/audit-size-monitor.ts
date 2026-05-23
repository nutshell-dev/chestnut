/**
 * @module L5.Cron.AuditSizeMonitor
 * @layer L5
 * @depends L1.FileSystem, L2.AuditLog
 *
 * Cron job: 周期 stat motion/audit.tsv + .clawforum/audit.tsv 大小、超阈值 emit audit + inbox notify。
 *
 * phase 1154 derive (user 2026-05-23 Terminal SIGABRT 诊断追溯)。
 */

import * as path from 'path';
import { isFileNotFound } from '../../../foundation/fs/types.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { InboxWriter } from '../../../foundation/messaging/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';

const AUDIT_SIZE_WARN_BYTES = 500 * 1024 * 1024;       // 500 MB
const AUDIT_SIZE_CRITICAL_BYTES = 1024 * 1024 * 1024;  // 1 GB

export interface AuditSizeMonitorOptions {
  fs: FileSystem;
  audit: AuditLog;
  clawforumDir: string;
  motionAuditPath: string;     // <clawforumDir>/motion/audit.tsv
  rootAuditPath: string;        // <clawforumDir>/audit.tsv
  warnBytes?: number;
  criticalBytes?: number;
  motionInbox?: InboxWriter;
}

export async function runAuditSizeMonitor(opts: AuditSizeMonitorOptions): Promise<void> {
  const warn = opts.warnBytes ?? AUDIT_SIZE_WARN_BYTES;
  const critical = opts.criticalBytes ?? AUDIT_SIZE_CRITICAL_BYTES;
  for (const p of [opts.motionAuditPath, opts.rootAuditPath]) {
    try {
      const stat = opts.fs.statSync(p);
      const size = stat.size;
      let level: 'warn' | 'critical' | null = null;
      if (size >= critical) level = 'critical';
      else if (size >= warn) level = 'warn';
      if (level) {
        opts.audit.write(
          CRON_AUDIT_EVENTS.AUDIT_SIZE_THRESHOLD_EXCEEDED,
          `path=${p}`,
          `size_bytes=${size}`,
          `level=${level}`,
        );
        const mb = Math.round(size / 1024 / 1024);
        opts.motionInbox?.writeSync({
          type: 'audit_size_alert',
          source: 'system',
          priority: level === 'critical' ? 'high' : 'normal',
          body: `audit.tsv size ${mb} MB (${level} threshold) at ${p}. 建议跑 α-3a rotation。`,
          idPrefix: `${Date.now()}_audit_size_alert`,
          filenameTag: 'audit_size_alert',
        });
      }
    } catch (err) {
      if (isFileNotFound(err)) continue; // 复用 α-1 helper
      opts.audit.write(
        CRON_AUDIT_EVENTS.AUDIT_SIZE_CHECK_FAILED,
        `path=${p}`,
        `code=${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`,
        `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
