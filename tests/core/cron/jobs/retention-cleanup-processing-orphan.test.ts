import { describe, it, expect, vi } from 'vitest';
import { cleanupRetention } from '../../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../../src/foundation/messaging/audit-events.js';
import type { FileSystem, FileEntry, StatInfo } from '../../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../../src/foundation/audit/index.js';

function mockFs(opts: {
  exists?: boolean;
  entries?: FileEntry[];
  statMtimeMs?: number;
}): FileSystem {
  return {
    existsSync: vi.fn(() => opts.exists ?? true),
    listSync: vi.fn(() => opts.entries ?? []),
    statSync: vi.fn((): StatInfo => ({
      size: 10,
      mtime: new Date(opts.statMtimeMs ?? Date.now()),
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
    utimes: vi.fn(),
    utimesSync: vi.fn(),
  } as unknown as FileSystem;
}

describe('cleanupRetention processing orphan (phase 1372 sub-1)', () => {
  it('deletes stale files from outbox/processing and emits OUTBOX_PROCESSING_ORPHAN_CLEANED', async () => {
    const now = Date.now();
    const fs = mockFs({ exists: true });
    (fs.listSync as ReturnType<typeof vi.fn>).mockImplementation((dir: string): FileEntry[] => {
      if (dir.includes('outbox/processing')) {
        return [
          { name: 'stale.md', path: `${dir}/stale.md`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 40 * 86400000) },
          { name: 'fresh.md', path: `${dir}/fresh.md`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 1 * 86400000) },
        ];
      }
      return [];
    });
    (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation((p: string): StatInfo => ({
      size: 10,
      mtime: new Date(p.includes('stale') ? now - 40 * 86400000 : now - 1 * 86400000),
      ctime: new Date(),
      isDirectory: false,
      isFile: true,
    }));
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit: AuditLog = { write: (t, ...c) => writes.push({ type: t, cols: c.map(String) }) };

    const deleted = await cleanupRetention({ motionDir: '/m', fs, audit, maxDays: { outbox: 30 } });

    expect(deleted).toBe(1);
    const deletedCalls = (fs.deleteSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(deletedCalls.length).toBe(1);
    expect(deletedCalls[0][0]).toContain('stale.md');

    const orphanEvent = writes.find(w => w.type === MESSAGING_AUDIT_EVENTS.OUTBOX_PROCESSING_ORPHAN_CLEANED);
    expect(orphanEvent).toBeDefined();
    expect(orphanEvent!.cols.some(c => c.includes('count=1'))).toBe(true);
  });

  it('does not emit OUTBOX_PROCESSING_ORPHAN_CLEANED when no stale files in outbox/processing', async () => {
    const now = Date.now();
    const fs = mockFs({ exists: true });
    (fs.listSync as ReturnType<typeof vi.fn>).mockImplementation((dir: string): FileEntry[] => {
      if (dir.includes('outbox/processing')) {
        return [
          { name: 'fresh.md', path: `${dir}/fresh.md`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 1 * 86400000) },
        ];
      }
      return [];
    });
    (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation((): StatInfo => ({
      size: 10,
      mtime: new Date(now - 1 * 86400000),
      ctime: new Date(),
      isDirectory: false,
      isFile: true,
    }));
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit: AuditLog = { write: (t, ...c) => writes.push({ type: t, cols: c.map(String) }) };

    const deleted = await cleanupRetention({ motionDir: '/m', fs, audit, maxDays: { outbox: 30 } });

    expect(deleted).toBe(0);
    const orphanEvent = writes.find(w => w.type === MESSAGING_AUDIT_EVENTS.OUTBOX_PROCESSING_ORPHAN_CLEANED);
    expect(orphanEvent).toBeUndefined();
  });

  it('0 false positive: outbox/processing skipped when maxDays.outbox unset', async () => {
    const fs = mockFs({ exists: true });
    const audit: AuditLog = { write: vi.fn() };

    const deleted = await cleanupRetention({ motionDir: '/m', fs, audit, maxDays: { inbox: 30 } });

    expect(deleted).toBe(0);
    // inbox dirs may be listed, but outbox/processing must not be
    const listCalls = (fs.listSync as ReturnType<typeof vi.fn>).mock.calls as string[][];
    expect(listCalls.some(c => c[0].includes('outbox/processing'))).toBe(false);
  });
});
