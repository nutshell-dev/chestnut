import { type ChestnutRoot } from '../../../foundation/paths.js';
import { formatErr } from "../../../foundation/utils/index.js";
/**
 * @module L5.Cron.AuditSizeMonitor
 * @layer L5
 * @depends L1.FileSystem, L2.AuditLog
 *
 * Cron job: 周期 stat motion/audit.tsv + .chestnut/audit.tsv 大小、超阈值 emit audit + viewport stream notify (phase 8).
 *
 * 阈值语义（phase 8 reframe）：informational only / 供开发者参考 / 无 motion action / 直接 viewport 显示提醒.
 *
 * phase 1154 derive (user 2026-05-23 Terminal SIGABRT 诊断追溯).
 * phase 8 reframe: motion inbox → viewport stream / dedup transition / 英文 self-contained.
 */

import { isFileNotFound } from '../../../foundation/fs/types.js';
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { StreamLog } from '../../../foundation/stream/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS = 30_000;

const AUDIT_SIZE_WARN_BYTES = 500 * 1024 * 1024;       // 500 MB
const AUDIT_SIZE_CRITICAL_BYTES = 1024 * 1024 * 1024;  // 1 GB

// phase 8: dedup per audit path / daemon process 生命周期内、under→over 时 emit / over→under 清状态允许下次再 fire
const auditOverThreshold = new Map<string, 'warn' | 'critical'>();

export interface AuditSizeMonitorOptions {
  fs: FileSystem;
  audit: AuditLog;
  chestnutRoot: ChestnutRoot;
  motionAuditPath: string;     // <chestnutRoot>/motion/audit.tsv
  rootAuditPath: string;        // <chestnutRoot>/audit.tsv
  warnBytes?: number;
  criticalBytes?: number;
  streamLog?: StreamLog;   // phase 8: motion streamWriter / 警告改 viewport user_notify 注入
  signal?: AbortSignal;
}

export interface AuditSizeMonitorJobDeps {
  fs: FileSystem;
  audit: AuditLog;
  chestnutRoot: ChestnutRoot;
  motionAuditPath: string;
  rootAuditPath: string;
  warnBytes?: number;
  criticalBytes?: number;
  streamLog?: StreamLog;
}

export async function runAuditSizeMonitor(opts: AuditSizeMonitorOptions): Promise<void> {
  const warn = opts.warnBytes ?? AUDIT_SIZE_WARN_BYTES;
  const critical = opts.criticalBytes ?? AUDIT_SIZE_CRITICAL_BYTES;
  for (const p of [opts.motionAuditPath, opts.rootAuditPath]) {
    if (opts.signal?.aborted) return;
    try {
      const stat = opts.fs.statSync(p);
      const size = stat.size;
      let level: 'warn' | 'critical' | null = null;
      if (size >= critical) level = 'critical';
      else if (size >= warn) level = 'warn';

      const prevLevel = auditOverThreshold.get(p) ?? null;
      if (level) {
        opts.audit.write(
          CRON_AUDIT_EVENTS.AUDIT_SIZE_THRESHOLD_EXCEEDED,
          `path=${p}`,
          `size_bytes=${size}`,
          `level=${level}`,
        );
        // phase 8: only emit on transition (level change / new entry) — dedup steady-state
        if (prevLevel !== level) {
          const mb = Math.round(size / 1024 / 1024);
          opts.streamLog?.write({
            ts: Date.now(),
            type: 'user_notify',
            subtype: 'dev_warning',
            kind: 'audit_size',
            path: p,
            sizeMB: mb,
            level,
            // 语义：informational only / for developer reference / no action required
            message: `${p} size ${mb}MB reached ${level} threshold`,
          });
          auditOverThreshold.set(p, level);
        }
      } else if (prevLevel !== null) {
        // 恢复（如 rotation / 清理后）→ 清状态、允许下次再 fire
        auditOverThreshold.delete(p);
      }
    } catch (err) {
      if (isFileNotFound(err)) continue; // 复用 α-1 helper
      opts.audit.write(
        CRON_AUDIT_EVENTS.AUDIT_SIZE_CHECK_FAILED,
        `path=${p}`,
        `code=${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
  }
}

/** Test-only: reset dedup state between cases. */
export function __resetAuditSizeMonitorState(): void {
  auditOverThreshold.clear();
}

export function createAuditSizeMonitorJob(
  deps: AuditSizeMonitorJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'audit-size-monitor',
    enabled: globalConfig.cron.jobs.audit_size_monitor.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.audit_size_monitor.schedule, deps.audit),
    handler: (signal) => runAuditSizeMonitor({ ...deps, signal }),
    timeoutMs: AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS,
  };
}
