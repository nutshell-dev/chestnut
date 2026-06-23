/**
 * Phase 8 — audit-size-monitor viewport stream injection 反向测试
 *
 * (1) under threshold 不 emit
 * (2) over warn → emit THRESHOLD_EXCEEDED level=warn + streamLog dev_warning
 * (3) over critical → emit critical + streamLog dev_warning level=critical
 * (4) file 不存在不 emit CHECK_FAILED（α-1 helper 复用）
 * (5) dedup: same level 二次跑不 re-fire；level 升级 (warn→critical) re-fire
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runAuditSizeMonitor,
  __resetAuditSizeMonitorState,
} from '../../../../src/foundation/audit/jobs/audit-size-monitor.js';
import { FileNotFoundError } from '../../../../src/foundation/fs/types.js';
import { AUDIT_SIZE_MONITOR_AUDIT_EVENTS } from '../../../../src/foundation/audit/jobs/audit-size-monitor-audit-events.js';
import { makeAudit } from '../../../helpers/audit.js';
import type { FileSystem } from '../../../../src/foundation/fs/types.js';
import type { StreamLog } from '../../../../src/foundation/stream/index.js';

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

describe('phase 8 — audit-size-monitor viewport stream', () => {
  beforeEach(() => { __resetAuditSizeMonitorState(); });

  it('under threshold → 0 emit', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsWithSize(100 * 1024 * 1024);
    const streamLog: StreamLog = { write: vi.fn() };
    await runAuditSizeMonitor({
      fs, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      streamLog,
    });
    expect(events).toHaveLength(0);
    expect(streamLog.write).not.toHaveBeenCalled();
  });

  it('over warn (600 MB) → THRESHOLD_EXCEEDED level=warn + streamLog dev_warning', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsWithSize(600 * 1024 * 1024);
    const streamLog: StreamLog = { write: vi.fn() };
    await runAuditSizeMonitor({
      fs, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      streamLog,
    });
    expect(events).toHaveLength(2);
    expect(events[0][0]).toBe(AUDIT_SIZE_MONITOR_AUDIT_EVENTS.THRESHOLD_EXCEEDED);
    expect(events[0]).toContain('level=warn');
    expect(streamLog.write).toHaveBeenCalledTimes(2);
    expect(streamLog.write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_notify',
      subtype: 'dev_warning',
      kind: 'audit_size',
      level: 'warn',
    }));
  });

  it('over critical (1.2 GB) → critical + streamLog dev_warning level=critical', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsWithSize(1200 * 1024 * 1024);
    const streamLog: StreamLog = { write: vi.fn() };
    await runAuditSizeMonitor({
      fs, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      streamLog,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('level=critical');
    expect(streamLog.write).toHaveBeenCalledTimes(2);
    expect(streamLog.write).toHaveBeenCalledWith(expect.objectContaining({
      level: 'critical',
    }));
  });

  it('file not found → 0 emit CHECK_FAILED', async () => {
    const { audit, events } = makeAudit();
    const fs = makeFsThrow(new FileNotFoundError('/tmp/test/motion/audit.tsv'));
    await runAuditSizeMonitor({
      fs, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
    });
    expect(events).toHaveLength(0);
  });

  it('dedup: same level 二次跑不 re-fire；warn→critical 升级 re-fire', async () => {
    const { audit } = makeAudit();
    const streamLog: StreamLog = { write: vi.fn() };
    const fsWarn = makeFsWithSize(600 * 1024 * 1024);
    await runAuditSizeMonitor({
      fs: fsWarn, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      streamLog,
    });
    expect(streamLog.write).toHaveBeenCalledTimes(2); // motion + root warn

    // 同 level 二次跑 → 0 新 write
    await runAuditSizeMonitor({
      fs: fsWarn, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      streamLog,
    });
    expect(streamLog.write).toHaveBeenCalledTimes(2);

    // 升级 warn → critical
    const fsCritical = makeFsWithSize(1200 * 1024 * 1024);
    await runAuditSizeMonitor({
      fs: fsCritical, audit,
      chestnutRoot: '/tmp/test',
      motionAuditPath: '/tmp/test/motion/audit.tsv',
      rootAuditPath: '/tmp/test/audit.tsv',
      streamLog,
    });
    expect(streamLog.write).toHaveBeenCalledTimes(4); // +2 critical
  });
});
