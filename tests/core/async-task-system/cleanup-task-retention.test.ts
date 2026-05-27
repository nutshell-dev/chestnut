import { describe, it, expect, vi } from 'vitest';
import { cleanupTaskRetention } from '../../../src/core/async-task-system/index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { FileSystem, FileEntry, StatInfo } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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
  } as unknown as FileSystem;
}

describe('cleanupTaskRetention', () => {
  it('deletes expired files and keeps recent ones', async () => {
    const now = Date.now();
    const fs = mockFs({ exists: true });
    (fs.listSync as ReturnType<typeof vi.fn>).mockImplementation((dir: string): FileEntry[] => {
      if (dir.includes('tasks/done')) {
        return [
          { name: 'old.json', path: `${dir}/old.json`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 40 * 86400000) },
          { name: 'new.json', path: `${dir}/new.json`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 1 * 86400000) },
        ];
      }
      if (dir.includes('tasks/failed')) {
        return [
          { name: 'old2.json', path: `${dir}/old2.json`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 40 * 86400000) },
        ];
      }
      return [];
    });
    (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation((p: string): StatInfo => ({
      size: 10,
      mtime: new Date(p.includes('old') ? now - 40 * 86400000 : now - 1 * 86400000),
      ctime: new Date(),
      isDirectory: false,
      isFile: true,
    }));
    const audit: AuditLog = { write: vi.fn() };

    const deleted = await cleanupTaskRetention({ motionDir: '/m', fs, audit, maxDays: 30 });

    expect(deleted).toBe(2);
    const deletedCalls = (fs.deleteSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(deletedCalls.length).toBe(2);
    expect(deletedCalls[0][0]).toContain('old.json');
    expect(deletedCalls[1][0]).toContain('old2.json');
  });

  it('skips directories inside target dirs', async () => {
    const now = Date.now();
    const fs = mockFs({
      exists: true,
      entries: [
        { name: 'subdir', path: '/m/tasks/done/subdir', isDirectory: true, isFile: false, size: 0, mtime: new Date(now - 40 * 86400000) },
      ],
    });
    const audit: AuditLog = { write: vi.fn() };

    const deleted = await cleanupTaskRetention({ motionDir: '/m', fs, audit, maxDays: 30 });

    expect(deleted).toBe(0);
    expect(fs.deleteSync).not.toHaveBeenCalled();
  });

  it('handles missing or empty dirs gracefully', async () => {
    const fs = mockFs({ exists: false });
    const audit: AuditLog = { write: vi.fn() };

    const deleted = await cleanupTaskRetention({ motionDir: '/m', fs, audit, maxDays: 30 });

    expect(deleted).toBe(0);
    expect(fs.listSync).not.toHaveBeenCalled();
  });

  it('emits audit on per-file delete failure', async () => {
    const now = Date.now();
    const fs = mockFs({ exists: true });
    (fs.listSync as ReturnType<typeof vi.fn>).mockImplementation((dir: string): FileEntry[] => {
      return [
        { name: 'old.json', path: `${dir}/old.json`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 40 * 86400000) },
      ];
    });
    (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation((): StatInfo => ({
      size: 10,
      mtime: new Date(now - 40 * 86400000),
      ctime: new Date(),
      isDirectory: false,
      isFile: true,
    }));
    (fs.deleteSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('permission denied');
    });
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit: AuditLog = { write: (t, ...c) => writes.push({ type: t, cols: c.map(String) }) };

    const deleted = await cleanupTaskRetention({ motionDir: '/m', fs, audit, maxDays: 30 });

    expect(deleted).toBe(0);
    expect(writes.some(w => w.type === TASK_AUDIT_EVENTS.CLEANUP_RETENTION_DELETE_FAILED)).toBe(true);
  });
});
