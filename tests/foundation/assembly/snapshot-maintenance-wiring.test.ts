import { describe, expect, it, vi } from 'vitest';
import { createSnapshotMaintenanceCronJob } from '../../../src/assembly/motion-addons.js';
import type { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { cronConfigSchema } from '../../../src/foundation/cron/index.js';

const config = {
  cron: {
    jobs: {
      snapshot_maintenance: {
        enabled: true,
        schedule: 'daily:04:30',
        timeout_ms: 123_000,
        git_warn_bytes: 456,
        loose_object_warn_count: 78,
        disk_available_warn_bytes: 901,
      },
    },
  },
};

describe('Snapshot maintenance Assembly wiring (phase 2196)', () => {
  it('has bounded maintenance and actionable warning defaults', () => {
    const parsed = cronConfigSchema.parse({});
    expect(parsed.jobs.snapshot_maintenance).toMatchObject({
      enabled: true,
      schedule: 'daily:04:30',
      timeout_ms: 300_000,
      git_warn_bytes: 512 * 1024 * 1024,
      loose_object_warn_count: 10_000,
      disk_available_warn_bytes: 1024 * 1024 * 1024,
    });
  });

  it('binds only the assembled Snapshot and forwards cancellation, timeout, and thresholds', async () => {
    const maintain = vi.fn().mockResolvedValue({ kind: 'completed' });
    const snapshot = { maintain } as unknown as Snapshot;
    const job = createSnapshotMaintenanceCronJob(snapshot, config);

    expect(job).toMatchObject({
      name: 'snapshot-maintenance',
      enabled: true,
      schedule: { type: 'daily', time: '04:30' },
      timeoutMs: 123_000,
    });
    const controller = new AbortController();
    await job.handler(controller.signal);

    expect(maintain).toHaveBeenCalledWith({
      timeoutMs: 123_000,
      signal: controller.signal,
      thresholds: {
        gitWarnBytes: 456,
        looseObjectWarnCount: 78,
        diskAvailableWarnBytes: 901,
      },
    });
  });
});
