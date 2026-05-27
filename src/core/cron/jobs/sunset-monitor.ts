import { type ClawforumRoot } from '../../../foundation/identity/index.js';
/**
 * @module L5.Cron.SunsetMonitor
 * @layer L5
 * @depends L1.FileSystem, L2.AuditLog, L2.Messaging
 *
 * Cron job: 30 day 周期 query `*_LEGACY_*` audit const 计数 (跨 motion + claws audit.tsv)
 * 0 hit 持续 30 day → emit SUNSET_READY + motion inbox notify (per-LEGACY-const granularity)
 *
 * phase 1258 derive (audit-2026-05-25 F.22 sunset observability infra cluster).
 */

import { isFileNotFound } from '../../../foundation/fs/types.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { InboxWriter } from '../../../foundation/messaging/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const SUNSET_MONITOR_CRON_TIMEOUT_MS = 60_000;
export const SUNSET_DEFAULT_THRESHOLD_DAYS = 30;

export interface SunsetMonitorOptions {
  fs: FileSystem;
  audit: AuditLog;
  clawforumRoot: ClawforumRoot;
  motionAuditPath: string;
  rootAuditPath: string;
  legacyConsts: string[]; // e.g. ['PID_FILE_LEGACY_FORMAT', 'INBOX_LEGACY_CLAW_ID_FIELD', 'LEGACY_PENDING_TASK_NO_MODE']
  thresholdDays?: number;
  motionInbox?: InboxWriter;
  signal?: AbortSignal;
}

export async function runSunsetMonitor(opts: SunsetMonitorOptions): Promise<void> {
  const threshold = opts.thresholdDays ?? SUNSET_DEFAULT_THRESHOLD_DAYS;
  const cutoffMs = Date.now() - threshold * 24 * 3600 * 1000;
  for (const constName of opts.legacyConsts) {
    if (opts.signal?.aborted) return;
    try {
      const count = await queryAuditCount(opts.fs, [opts.motionAuditPath, opts.rootAuditPath], constName, cutoffMs, opts.signal);
      if (count === 0) {
        opts.audit.write(CRON_AUDIT_EVENTS.SUNSET_READY, `const=${constName}`, `threshold_days=${threshold}`);
        if (opts.motionInbox) {
          opts.motionInbox.writeSync({
            type: 'sunset_ready',
            source: 'system',
            priority: 'normal',
            body: `Audit const ${constName} 0 hit over ${threshold} days. Consider removing legacy fallback.`,
            idPrefix: `${Date.now()}_sunset_ready`,
          });
        }
      }
    } catch (err) {
      opts.audit.write(CRON_AUDIT_EVENTS.SUNSET_QUERY_FAIL, `const=${constName}`, `err=${(err as Error).message}`);
    }
  }
}

async function queryAuditCount(
  fs: FileSystem,
  paths: string[],
  constName: string,
  cutoffMs: number,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  for (const p of paths) {
    if (signal?.aborted) return total;
    try {
      const content = fs.readSync(p);
      for (const line of content.split('\n')) {
        if (signal?.aborted) return total;
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        // parts[0] = ts, parts[1] = seq=..., parts[2] = type (escaped)
        const ts = parts[0];
        const type = unesc(parts[2]);
        if (type !== constName) continue;
        const tsMs = Date.parse(ts);
        if (!isNaN(tsMs) && tsMs >= cutoffMs) {
          total++;
        }
      }
    } catch (err) {
      if (isFileNotFound(err)) continue;
      throw err;
    }
  }
  return total;
}

/** Unescape audit.tsv escaped value */
function unesc(s: string): string {
  return s
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\0/g, '\0')
    .replace(/\\\\/g, '\\');
}
