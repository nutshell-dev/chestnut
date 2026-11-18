/**
 * Bounded, observable maintenance for one Snapshot repository.
 * No history deletion: git gc always uses --no-prune.
 */
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import { formatErr } from '../node-utils/index.js';
import {
  emitSnapshotMaintenanceCompleted,
  emitSnapshotMaintenanceFailed,
  emitSnapshotMaintenanceSkipped,
  emitSnapshotSpaceWarning,
} from './audit-emit.js';
import type {
  SnapshotMaintenanceOptions,
  SnapshotMaintenanceResult,
  SnapshotMaintenanceThresholds,
  SnapshotRepositoryStats,
  SnapshotSpaceWarning,
} from './maintenance-types.js';

export const SNAPSHOT_MAINTENANCE_DEFAULT_TIMEOUT_MS = 300_000;
export const SNAPSHOT_MAINTENANCE_DEFAULT_GIT_WARN_BYTES = 512 * 1024 * 1024;
export const SNAPSHOT_MAINTENANCE_DEFAULT_LOOSE_OBJECT_WARN_COUNT = 10_000;
export const SNAPSHOT_MAINTENANCE_DEFAULT_DISK_AVAILABLE_WARN_BYTES = 1024 * 1024 * 1024;

interface MaintenanceDeps {
  dir: string;
  audit: AuditLog;
  fs: FileSystem;
  git(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ stdout: string }>;
}

const DEFAULT_THRESHOLDS: SnapshotMaintenanceThresholds = {
  gitWarnBytes: SNAPSHOT_MAINTENANCE_DEFAULT_GIT_WARN_BYTES,
  looseObjectWarnCount: SNAPSHOT_MAINTENANCE_DEFAULT_LOOSE_OBJECT_WARN_COUNT,
  diskAvailableWarnBytes: SNAPSHOT_MAINTENANCE_DEFAULT_DISK_AVAILABLE_WARN_BYTES,
};

async function directoryBytes(fs: FileSystem): Promise<number> {
  const entries = await fs.list('.git', { recursive: true });
  return entries.reduce((total, entry) => total + (entry.isFile ? entry.size : 0), 0);
}

function parseCountObjects(stdout: string): {
  looseObjectCount: number;
  packBytes: number;
  packCount: number;
} {
  const values = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^([a-z-]+):\s+(\d+)$/);
    if (match) values.set(match[1], Number(match[2]));
  }
  const looseObjectCount = values.get('count');
  const packBytes = values.get('size-pack');
  const packCount = values.get('packs');
  if (looseObjectCount === undefined || packBytes === undefined || packCount === undefined) {
    throw new Error(`Unexpected git count-objects output: ${stdout}`);
  }
  return { looseObjectCount, packBytes: packBytes * 1024, packCount };
}

async function readRepositoryStats(deps: MaintenanceDeps): Promise<SnapshotRepositoryStats> {
  const [objects, gitBytes, disk] = await Promise.all([
    deps.git(['count-objects', '-v']),
    directoryBytes(deps.fs),
    deps.fs.statFs('.'),
  ]);
  return {
    ...parseCountObjects(objects.stdout),
    gitBytes,
    diskAvailableBytes: disk.availableBytes,
  };
}

function collectWarnings(
  stats: SnapshotRepositoryStats,
  thresholds: SnapshotMaintenanceThresholds,
): SnapshotSpaceWarning[] {
  const warnings: SnapshotSpaceWarning[] = [];
  if (stats.gitBytes >= thresholds.gitWarnBytes) {
    warnings.push({ kind: 'git_size', actual: stats.gitBytes, threshold: thresholds.gitWarnBytes });
  }
  if (stats.looseObjectCount >= thresholds.looseObjectWarnCount) {
    warnings.push({
      kind: 'loose_objects',
      actual: stats.looseObjectCount,
      threshold: thresholds.looseObjectWarnCount,
    });
  }
  if (stats.diskAvailableBytes <= thresholds.diskAvailableWarnBytes) {
    warnings.push({
      kind: 'disk_available',
      actual: stats.diskAvailableBytes,
      threshold: thresholds.diskAvailableWarnBytes,
    });
  }
  return warnings;
}

function failureKind(rawErr: unknown): Extract<SnapshotMaintenanceResult, { kind: 'failed' }>['reason'] {
  const err = rawErr as {
    code?: string;
    termination?: { trigger?: string };
    message?: string;
  };
  if (err?.code === 'ENOSPC' || /no space left on device/i.test(err?.message ?? '')) return 'disk_full';
  if (err?.termination?.trigger === 'timeout' || /timed out/i.test(err?.message ?? '')) return 'timeout';
  if (err?.termination?.trigger === 'abort') return 'cancelled';
  return 'git';
}

export async function runSnapshotMaintenance(
  deps: MaintenanceDeps,
  options: SnapshotMaintenanceOptions = {},
): Promise<SnapshotMaintenanceResult> {
  if (options.signal?.aborted) {
    emitSnapshotMaintenanceSkipped(deps.audit, { dir: deps.dir, reason: 'cancelled' });
    return { kind: 'skipped', reason: 'cancelled' };
  }

  let before: SnapshotRepositoryStats;
  try {
    before = await readRepositoryStats(deps);
  } catch (error) {
    const reason = formatErr(error);
    emitSnapshotMaintenanceFailed(deps.audit, { dir: deps.dir, kind: 'stats', reason });
    return { kind: 'failed', reason: 'stats', error: reason };
  }

  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const warnings = collectWarnings(before, thresholds);
  for (const warning of warnings) {
    emitSnapshotSpaceWarning(deps.audit, { dir: deps.dir, ...warning });
  }

  try {
    await deps.git(['gc', '--no-prune'], {
      timeoutMs: options.timeoutMs ?? SNAPSHOT_MAINTENANCE_DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    const kind = failureKind(error);
    const reason = formatErr(error);
    emitSnapshotMaintenanceFailed(deps.audit, { dir: deps.dir, kind, reason });
    return { kind: 'failed', reason: kind, error: reason, before };
  }

  let after: SnapshotRepositoryStats;
  try {
    after = await readRepositoryStats(deps);
  } catch (error) {
    const reason = formatErr(error);
    emitSnapshotMaintenanceFailed(deps.audit, { dir: deps.dir, kind: 'stats', reason });
    return { kind: 'failed', reason: 'stats', error: reason, before };
  }
  emitSnapshotMaintenanceCompleted(deps.audit, {
    dir: deps.dir,
    before,
    after,
    warnings: warnings.length,
  });
  return { kind: 'completed', before, after, warnings };
}
