import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronRunner, type CronJob } from '../../../src/core/cron/runner.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

describe('CronRunner handler sync throw', () => {
  let audit: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 3, 21, 10, 30, 0) });
    audit = makeMockAudit();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('handler sync throw 自动转 reject + audit JOB_ERROR + running 清空', async () => {
    const handler = vi.fn(() => {
      throw new Error('sync');
    });
    const job: CronJob = {
      name: 'sync-throw',
      enabled: true,
      schedule: { type: 'hourly' },
      handler,
    };
    const runner = new CronRunner([job], audit as unknown as AuditLog);

    runner.tick();
    await Promise.resolve();
    await vi.runAllTicks();

    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.JOB_ERROR,
      'job=sync-throw',
      expect.stringContaining('run_key='),
      'error=sync',
    );

    expect((runner as unknown as { running: Set<string> }).running.has('sync-throw')).toBe(false);
  });
});
