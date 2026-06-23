import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDiskMonitor, __resetDiskMonitorState } from '../../../src/foundation/cron/jobs/disk-monitor.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { StreamLog } from '../../../src/foundation/stream/index.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';

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

function makeAuditMock(): AuditLog { return { write: vi.fn() }; }

function makeMockTopology(): ClawTopology {
  return {
    enumerate: () => ['claw1'],
    resolve: () => ({ kind: 'local', clawDir: '/tmp/test/claws/claw1' }),
    read: async () => '',
    readJSON: async () => ({} as any),
  };
}

function makeOpts(overrides: Partial<{
  limitMB: number; fs: FileSystem; audit: AuditLog; motionAudit: AuditLog; streamLog: StreamLog;
}> = {}) {
  return {
    clawsDir: '/tmp/test/claws',
    clawTopology: makeMockTopology(),
    limitMB: 100,
    fs: makeFsMock(0),
    audit: makeAuditMock(),
    motionAudit: makeAuditMock(),
    streamLog: { write: vi.fn() } as StreamLog,
    ...overrides,
  };
}

describe('phase 8 — disk-monitor viewport stream injection', () => {
  beforeEach(() => { __resetDiskMonitorState(); });

  it('threshold exceeded triggers streamLog.write with dev_warning user_notify', async () => {
    const opts = makeOpts({ limitMB: 100, fs: makeFsMock(150 * 1024 * 1024) });
    await runDiskMonitor(opts as any);
    expect(opts.streamLog.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_notify',
        subtype: 'dev_warning',
        kind: 'disk',
        totalMB: 150,
        limitMB: 100,
      }),
    );
  });

  it('threshold not exceeded does NOT call streamLog.write', async () => {
    const opts = makeOpts({ limitMB: 100, fs: makeFsMock(50 * 1024 * 1024) });
    await runDiskMonitor(opts as any);
    expect(opts.streamLog.write).not.toHaveBeenCalled();
  });

  it('dedup: second invocation while still over threshold does NOT re-fire', async () => {
    const streamLog: StreamLog = { write: vi.fn() };
    const opts = makeOpts({ limitMB: 100, fs: makeFsMock(150 * 1024 * 1024), streamLog });
    await runDiskMonitor(opts as any);
    await runDiskMonitor(opts as any);
    expect(streamLog.write).toHaveBeenCalledTimes(1);
  });

  it('recovery: under → over → under → over re-fires twice', async () => {
    const streamLog: StreamLog = { write: vi.fn() };
    await runDiskMonitor(makeOpts({ limitMB: 100, fs: makeFsMock(150 * 1024 * 1024), streamLog }) as any);
    await runDiskMonitor(makeOpts({ limitMB: 100, fs: makeFsMock(50 * 1024 * 1024), streamLog }) as any);
    await runDiskMonitor(makeOpts({ limitMB: 100, fs: makeFsMock(150 * 1024 * 1024), streamLog }) as any);
    expect(streamLog.write).toHaveBeenCalledTimes(2);
  });
});
