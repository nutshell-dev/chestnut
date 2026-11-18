import { z } from 'zod';
import {
  SNAPSHOT_MAINTENANCE_DEFAULT_DISK_AVAILABLE_WARN_BYTES,
  SNAPSHOT_MAINTENANCE_DEFAULT_GIT_WARN_BYTES,
  SNAPSHOT_MAINTENANCE_DEFAULT_LOOSE_OBJECT_WARN_COUNT,
  SNAPSHOT_MAINTENANCE_DEFAULT_TIMEOUT_MS,
} from './maintenance.js';

/** Snapshot-owned cron job policy; Cron composes its owned schedule field. */
export const snapshotMaintenanceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeout_ms: z.number().int().min(1000).default(SNAPSHOT_MAINTENANCE_DEFAULT_TIMEOUT_MS),
  git_warn_bytes: z.number().int().min(1).default(SNAPSHOT_MAINTENANCE_DEFAULT_GIT_WARN_BYTES),
  loose_object_warn_count: z.number().int().min(1).default(SNAPSHOT_MAINTENANCE_DEFAULT_LOOSE_OBJECT_WARN_COUNT),
  disk_available_warn_bytes: z.number().int().min(0).default(SNAPSHOT_MAINTENANCE_DEFAULT_DISK_AVAILABLE_WARN_BYTES),
});

export type SnapshotMaintenanceConfig = z.output<typeof snapshotMaintenanceConfigSchema>;
