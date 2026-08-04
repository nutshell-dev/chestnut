import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import {
  AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS,
  __resetAuditSizeMonitorState,
} from '../../../src/foundation/audit/jobs/audit-size-monitor.js';
import { CRON_AUDIT_EVENTS } from '../../../src/foundation/cron/audit-events.js';
import { parseSchedule } from '../../../src/foundation/cron/runner.js';
import { createAuditSizeMonitorCronJob } from '../../../src/assembly/motion-addons.js';

function makeFs(): FileSystem {
  return {
    statSync: () => ({ size: 0, mtime: new Date(), ctime: new Date(), isDirectory: false, isFile: true }),
  } as unknown as FileSystem;
}

function makeMockAudit(): AuditLog {
  return { write: vi.fn() } as unknown as AuditLog;
}

describe('phase 1242 Step A: audit-size-monitor CronJob wiring in Assembly', () => {
  beforeEach(() => { __resetAuditSizeMonitorState(); });

  it('composes name/enabled/schedule/handler/timeout from config', () => {
    const audit = makeMockAudit();
    const job = createAuditSizeMonitorCronJob(
      {
        fs: makeFs(),
        audit,
        primaryAuditPath: '/tmp/test/motion/audit.tsv',
        secondaryAuditPath: '/tmp/test/audit/audit.tsv',
        legacyAuditPath: '/tmp/test/audit.tsv',
      },
      { cron: { jobs: { audit_size_monitor: { enabled: true, schedule: 'daily:06:00' } } } },
    );

    expect(job.name).toBe('audit-size-monitor');
    expect(job.enabled).toBe(true);
    expect(job.schedule).toEqual(parseSchedule('daily:06:00'));
    expect(job.timeoutMs).toBe(AUDIT_SIZE_MONITOR_CRON_TIMEOUT_MS);
    expect(typeof job.handler).toBe('function');
  });

  it('wires audit sink to parseSchedule fallback events', () => {
    const audit = makeMockAudit();
    const job = createAuditSizeMonitorCronJob(
      {
        fs: makeFs(),
        audit,
        primaryAuditPath: '/tmp/test/motion/audit.tsv',
        secondaryAuditPath: '/tmp/test/audit/audit.tsv',
        legacyAuditPath: '/tmp/test/audit.tsv',
      },
      { cron: { jobs: { audit_size_monitor: { enabled: true, schedule: 'bogus' } } } },
    );

    expect(job.schedule).toEqual({ type: 'hourly' });
    expect(audit.write).toHaveBeenCalledWith(
      CRON_AUDIT_EVENTS.PARSE_FALLBACK,
      'input=bogus',
      'fallback=hourly',
    );
  });

  it('handler forwards AbortSignal to the monitor', async () => {
    const audit = makeMockAudit();
    const signal = new AbortController().signal;
    const job = createAuditSizeMonitorCronJob(
      {
        fs: makeFs(),
        audit,
        primaryAuditPath: '/tmp/test/motion/audit.tsv',
        secondaryAuditPath: '/tmp/test/audit/audit.tsv',
        legacyAuditPath: '/tmp/test/audit.tsv',
      },
      { cron: { jobs: { audit_size_monitor: { enabled: true, schedule: 'hourly' } } } },
    );

    await expect(job.handler(signal)).resolves.toBeUndefined();
  });
});
