/**
 * Phase 1154 α-3b — audit-size-monitor cron job 反向测试
 *
 * 反向 4 项:
 *   (1) under threshold 不 emit：mock statSync return 100 MB → 0 emit
 *   (2) over warn 不 over critical emit warn 级：mock statSync return 600 MB → emit THRESHOLD_EXCEEDED level=warn 1 次
 *   (3) over critical emit critical 级 + 触 inbox notify high priority：mock statSync return 1.2 GB → emit + notifyInbox high
 *   (4) file 不存在不 emit CHECK_FAILED：mock statSync throw FileNotFoundError → 0 emit（per α-1 helper 复用）
 */
import { describe, it, expect, vi } from 'vitest';
import { runAuditSizeMonitor } from '../../../../src/core/cron/jobs/audit-size-monitor.js';
import { FileNotFoundError } from '../../../../src/foundation/fs/types.js';
import { CRON_AUDIT_EVENTS } from '../../../../src/core/cron/audit-events.js';
import { makeAudit } from '../../../helpers/audit.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';

function makeFsWithSize(sizeBytes: number): FileSystem {
  return {
    statSync: () => ({ size: sizeBytes, mtime: new Date(), ctime: new Date(), isDirectory: false, isFile: true }),
  } as unknown as FileSystem;
}

function makeFsThrow(err: unknown): FileSystem {
  return {
    statSync: () => { throw err; },
  } as unknown as FileSystem;
}

describe('phase 1154 — audit-size-monitor cron job', () => {
  it('under threshold → 0 emit', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsWithSize(100 * 1024 * 1024); // 100 MB
    await runAuditSizeMonitor({
      fs,
      audit,
      clawforumRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
    });
    expect(events).toHaveLength(0);
  });

  it('over warn (600 MB) → emit THRESHOLD_EXCEEDED level=warn 1 次', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsWithSize(600 * 1024 * 1024); // 600 MB
    const inboxWrite = vi.fn();
    await runAuditSizeMonitor({
      fs,
      audit,
      clawforumRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      motionInbox: { writeSync: inboxWrite } as unknown as Parameters<typeof runAuditSizeMonitor>[0]['motionInbox'],
    });
    expect(events).toHaveLength(2); // motion + root
    expect(events[0][0]).toBe(CRON_AUDIT_EVENTS.AUDIT_SIZE_THRESHOLD_EXCEEDED);
    expect(events[0]).toContain('level=warn');
    expect(inboxWrite).toHaveBeenCalledTimes(2);
    expect(inboxWrite).toHaveBeenCalledWith(expect.objectContaining({ priority: 'normal' }));
  });

  it('over critical (1.2 GB) → emit critical + inbox notify high priority', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsWithSize(1200 * 1024 * 1024); // 1.2 GB
    const inboxWrite = vi.fn();
    await runAuditSizeMonitor({
      fs,
      audit,
      clawforumRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      motionInbox: { writeSync: inboxWrite } as unknown as Parameters<typeof runAuditSizeMonitor>[0]['motionInbox'],
    });
    expect(events).toHaveLength(2);
    expect(events[0][0]).toBe(CRON_AUDIT_EVENTS.AUDIT_SIZE_THRESHOLD_EXCEEDED);
    expect(events[0]).toContain('level=critical');
    expect(inboxWrite).toHaveBeenCalledTimes(2);
    expect(inboxWrite).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high' }));
  });

  it('file not found → 0 emit CHECK_FAILED (α-1 helper reuse)', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsThrow(new FileNotFoundError('/tmp/test/motion/audit.tsv'));
    await runAuditSizeMonitor({
      fs,
      audit,
      clawforumRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
    });
    expect(events).toHaveLength(0);
  });
});
