import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { CRON_AUDIT_EVENTS } from '../audit-events.js';
import type { StreamLog } from '../../../foundation/stream/index.js';
import { CLAWSPACE_DIR } from '../../../assembly/claw-dirs.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const DISK_MONITOR_CRON_TIMEOUT_MS = 60_000;

// phase 8: dedup transition / 在 daemon process 生命周期内、仅在 under→over 时 emit / over→under 清状态允许下次再 fire
let diskOverThreshold = false;

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
      `reason=${formatErr(err)}`,
    );
    return 0; // partial scan / best-effort
  }
}

export interface DiskMonitorOptions {
  clawsDir: string;   // phase 84: caller (装配期) 算好 claws dir 后传入
  limitMB: number;        // 阈值（informational only / 仅作开发者参考、无 action）
  fs: FileSystem;
  audit: AuditLog;
  motionAudit: AuditLog;   // motion-side audit (装配方预 build)
  streamLog?: StreamLog;   // phase 8: motion streamWriter / 警告改 viewport user_notify 注入
  signal?: AbortSignal;
}

export interface DiskMonitorJobDeps {
  clawsDir: string;
  limitMB: number;
  fs: FileSystem;
  audit: AuditLog;
  motionAudit: AuditLog;
  streamLog?: StreamLog;
}

export async function runDiskMonitor(opts: DiskMonitorOptions): Promise<void> {
  const { clawsDir } = opts;
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
    // phase 8: only emit on under→over transition (dedup) / fire-and-forget viewport stream
    if (!diskOverThreshold) {
      opts.streamLog?.write({
        ts: Date.now(),
        type: 'user_notify',
        subtype: 'dev_warning',
        kind: 'disk',
        totalMB,
        limitMB: opts.limitMB,
        // 语义：informational only / for developer reference / no action required
        message: `claws disk usage ${totalMB}MB exceeds threshold ${opts.limitMB}MB`,
      });
      diskOverThreshold = true;
    }
  } else if (diskOverThreshold) {
    // 恢复 → 清状态、允许下次再 fire
    diskOverThreshold = false;
  }
}

/** Test-only: reset dedup state between cases. */
export function __resetDiskMonitorState(): void {
  diskOverThreshold = false;
}

export function createDiskMonitorJob(
  deps: DiskMonitorJobDeps,
  globalConfig: ClawGlobalConfig,
): CronJob {
  return {
    name: 'disk-monitor',
    enabled: globalConfig.cron.jobs.disk_monitor.enabled,
    schedule: parseSchedule(globalConfig.cron.jobs.disk_monitor.schedule, deps.audit),
    handler: (signal) => runDiskMonitor({ ...deps, signal }),
    timeoutMs: DISK_MONITOR_CRON_TIMEOUT_MS,
  };
}
