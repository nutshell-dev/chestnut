import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import type { FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import { DISK_MONITOR_AUDIT_EVENTS } from './disk-monitor-audit-events.js';
import type { StreamLog } from '../../../foundation/stream/index.js';
import { CLAWSPACE_DIR } from '../../../foundation/claw-paths.js';
import type { CronJob } from '../runner.js';
import { parseSchedule } from '../runner.js';
import type { ClawGlobalConfig } from '../../../foundation/config/index.js';
import type { ClawTopology } from '../../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../../constants.js';

/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per M#2 模块为自己业务语义负责).
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
      DISK_MONITOR_AUDIT_EVENTS.CHECK,
      `step=scan_failed`,
      `dir=${dir}`,
      `reason=${formatErr(err)}`,
    );
    return 0; // partial scan / best-effort
  }
}

export interface DiskMonitorOptions {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  limitMB: number;        // 阈值（informational only / 仅作开发者参考、无 action）
  fs: FileSystem;
  audit: AuditLog;
  motionAudit: AuditLog;   // motion-side audit (装配方预 build)
  streamLog?: StreamLog;   // phase 8: motion streamWriter / 警告改 viewport user_notify 注入
  signal?: AbortSignal;
}

export interface DiskMonitorJobDeps {
  clawTopology: ClawTopology;
  limitMB: number;
  fs: FileSystem;
  audit: AuditLog;
  motionAudit: AuditLog;
  streamLog?: StreamLog;
}

export async function runDiskMonitor(opts: DiskMonitorOptions): Promise<void> {
  const { clawTopology } = opts;

  let totalSize = 0;
  for (const clawId of clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID)) {
    if (opts.signal?.aborted) return;
    const location = clawTopology.resolve(clawId);
    if (location.kind !== 'local') continue;
    const clawspaceDir = path.join(location.clawDir, CLAWSPACE_DIR);
    if (opts.fs.existsSync(clawspaceDir)) {
      totalSize += getDirSize(clawspaceDir, opts.fs, opts.audit, opts.signal);
    }
  }

  const totalMB = Math.round(totalSize / 1024 / 1024);
  opts.audit.write(DISK_MONITOR_AUDIT_EVENTS.CHECK, `totalMB=${totalMB}`, `limitMB=${opts.limitMB}`);

  if (totalMB > opts.limitMB) {
    opts.audit.write(DISK_MONITOR_AUDIT_EVENTS.THRESHOLD_EXCEEDED, `totalMB=${totalMB}`, `limitMB=${opts.limitMB}`);
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
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetDiskMonitorState is for tests only');
  }
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
