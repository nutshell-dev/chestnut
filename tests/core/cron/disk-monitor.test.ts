import { describe, it, expect, vi } from 'vitest';
import { runDiskMonitor } from '../../../src/core/cron/jobs/disk-monitor.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { InboxWriter } from '../../../src/foundation/messaging/index.js';

function makeFsMock(totalSizeBytes: number): FileSystem {
  const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();
  dirs.set('/tmp/test/claws', [
    { name: 'claw1', isDirectory: true, size: 0 },
  ]);
  dirs.set('/tmp/test/claws/claw1', [
    { name: 'clawspace', isDirectory: true, size: 0 },
  ]);
  dirs.set('/tmp/test/claws/claw1/clawspace', [
    { name: 'file1.txt', isDirectory: false, size: totalSizeBytes },
  ]);

  return {
    existsSync: (p: string) => dirs.has(p) || p.startsWith('/tmp/test'),
    listSync: (p: string) => dirs.get(p) ?? [],
  } as unknown as FileSystem;
}

function makeAuditMock(): AuditLog {
  return { write: vi.fn() };
}

function makeOpts(overrides: Partial<{
  limitMB: number;
  fs: FileSystem;
  audit: AuditLog;
  motionAudit: AuditLog;
  motionInbox: InboxWriter;
}> = {}) {
  const writeSyncMock = vi.fn();
  return {
    clawforumRoot: '/tmp/test',
    motionInboxDir: '/tmp/test/motion/inbox/pending',
    limitMB: 100,
    fs: makeFsMock(0),
    audit: makeAuditMock(),
    motionAudit: makeAuditMock(),
    motionInbox: { writeSync: writeSyncMock } as unknown as InboxWriter,
    ...overrides,
  };
}

describe('Phase 542 — disk-monitor deps 装配方注入', () => {
  it('threshold exceeded triggers motionInbox.writeSync', async () => {
    // 150MB > 100MB limit
    const opts = makeOpts({
      limitMB: 100,
      fs: makeFsMock(150 * 1024 * 1024),
    });
    await runDiskMonitor(opts);
    expect(opts.motionInbox.writeSync).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cron_disk_warning' })
    );
  });

  it('threshold not exceeded does NOT call motionInbox.writeSync', async () => {
    // 50MB < 100MB limit
    const opts = makeOpts({
      limitMB: 100,
      fs: makeFsMock(50 * 1024 * 1024),
    });
    await runDiskMonitor(opts);
    expect(opts.motionInbox.writeSync).not.toHaveBeenCalled();
  });
});
