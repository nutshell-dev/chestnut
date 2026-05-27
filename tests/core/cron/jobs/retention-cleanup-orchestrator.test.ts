import { describe, it, expect, vi } from 'vitest';
import { runRetentionCleanup } from '../../../../src/core/cron/jobs/retention-cleanup.js';
import { CRON_AUDIT_EVENTS } from '../../../../src/core/cron/audit-events.js';
import * as messaging from '../../../../src/foundation/messaging/index.js';
import * as taskSystem from '../../../../src/core/async-task-system/index.js';
import * as dialogStore from '../../../../src/foundation/dialog-store/index.js';
import type { FileSystem, FileEntry, StatInfo } from '../../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../../src/foundation/audit/index.js';

function mockFs(): FileSystem {
  return {
    existsSync: vi.fn(() => true),
    listSync: vi.fn(() => []),
    statSync: vi.fn((): StatInfo => ({
      size: 10,
      mtime: new Date(),
      ctime: new Date(),
      isDirectory: false,
      isFile: true,
    })),
    deleteSync: vi.fn(),
    read: vi.fn(),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    list: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    writeAtomicSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readSync: vi.fn(),
    readBytesSync: vi.fn(),
    appendSync: vi.fn(),
    moveSync: vi.fn(),
    ensureDirSync: vi.fn(),
    resolve: vi.fn((p: string) => p),
  } as unknown as FileSystem;
}

describe('retention-cleanup orchestrator', () => {
  it('calls the 3 owner APIs and sums deleted counts', async () => {
    const fs = mockFs();
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit: AuditLog = { write: (t, ...c) => writes.push({ type: t, cols: c.map(String) }) };

    vi.spyOn(messaging, 'cleanupRetention').mockResolvedValue(3);
    vi.spyOn(taskSystem, 'cleanupTaskRetention').mockResolvedValue(5);
    vi.spyOn(dialogStore, 'cleanupArchives').mockResolvedValue(7);

    await runRetentionCleanup({
      motionDir: '/m',
      fs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60, dialog: 90 },
    });

    expect(messaging.cleanupRetention).toHaveBeenCalled();
    expect(taskSystem.cleanupTaskRetention).toHaveBeenCalled();
    expect(dialogStore.cleanupArchives).toHaveBeenCalled();

    const cleanupEvent = writes.find(w => w.type === CRON_AUDIT_EVENTS.RETENTION_CLEANUP);
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent!.cols.some(c => c.includes('deleted=15'))).toBe(true);
  });

  it('emits the final RETENTION_CLEANUP audit even when all counts are 0', async () => {
    const fs = mockFs();
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit: AuditLog = { write: (t, ...c) => writes.push({ type: t, cols: c.map(String) }) };

    vi.spyOn(messaging, 'cleanupRetention').mockResolvedValue(0);
    vi.spyOn(taskSystem, 'cleanupTaskRetention').mockResolvedValue(0);
    vi.spyOn(dialogStore, 'cleanupArchives').mockResolvedValue(0);

    await runRetentionCleanup({
      motionDir: '/m',
      fs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60, dialog: 90 },
    });

    const cleanupEvent = writes.find(w => w.type === CRON_AUDIT_EVENTS.RETENTION_CLEANUP);
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent!.cols.some(c => c.includes('deleted=0'))).toBe(true);
  });

  it('does not call fs.deleteSync directly', async () => {
    const fs = mockFs();
    const audit: AuditLog = { write: vi.fn() };

    vi.spyOn(messaging, 'cleanupRetention').mockResolvedValue(1);
    vi.spyOn(taskSystem, 'cleanupTaskRetention').mockResolvedValue(1);
    vi.spyOn(dialogStore, 'cleanupArchives').mockResolvedValue(1);

    await runRetentionCleanup({
      motionDir: '/m',
      fs,
      audit,
      maxDays: { inbox: 30, outbox: 30, tasks: 60, dialog: 90 },
    });

    expect(fs.deleteSync).not.toHaveBeenCalled();
  });

  it('skips task and dialog cleanup when maxDays is not configured', async () => {
    const fs = mockFs();
    const audit: AuditLog = { write: vi.fn() };

    vi.spyOn(messaging, 'cleanupRetention').mockResolvedValue(0);
    const taskSpy = vi.spyOn(taskSystem, 'cleanupTaskRetention').mockResolvedValue(0);
    const dialogSpy = vi.spyOn(dialogStore, 'cleanupArchives').mockResolvedValue(0);

    await runRetentionCleanup({
      motionDir: '/m',
      fs,
      audit,
      maxDays: { inbox: 30 },
    });

    expect(taskSpy).not.toHaveBeenCalled();
    expect(dialogSpy).not.toHaveBeenCalled();
  });
});
