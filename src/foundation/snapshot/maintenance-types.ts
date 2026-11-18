export interface SnapshotMaintenanceThresholds {
  gitWarnBytes: number;
  looseObjectWarnCount: number;
  diskAvailableWarnBytes: number;
}

export interface SnapshotMaintenanceOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  thresholds?: SnapshotMaintenanceThresholds;
}

export interface SnapshotRepositoryStats {
  gitBytes: number;
  looseObjectCount: number;
  packBytes: number;
  packCount: number;
  diskAvailableBytes: number;
}

export type SnapshotSpaceWarning =
  | { kind: 'git_size'; actual: number; threshold: number }
  | { kind: 'loose_objects'; actual: number; threshold: number }
  | { kind: 'disk_available'; actual: number; threshold: number };

export type SnapshotMaintenanceResult =
  | {
      kind: 'completed';
      before: SnapshotRepositoryStats;
      after: SnapshotRepositoryStats;
      warnings: SnapshotSpaceWarning[];
    }
  | { kind: 'skipped'; reason: 'cancelled' }
  | {
      kind: 'failed';
      reason: 'timeout' | 'cancelled' | 'disk_full' | 'git' | 'stats';
      error: string;
      before?: SnapshotRepositoryStats;
    };
