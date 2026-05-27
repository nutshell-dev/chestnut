import { describe, it, expect, vi } from 'vitest';
import { runRetentionCleanup } from '../../../src/core/cron/jobs/retention-cleanup.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
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
    // stub remaining FileSystem interface
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

describe('retention-cleanup', () => {
  it('反向 1: expired files deleted, recent kept', async () => {
    const now = Date.now();
    const fs = mockFs({ exists: true });
    (fs.listSync as ReturnType<typeof vi.fn>).mockImplementation((dir: string): FileEntry[] => {
      if (dir.includes('inbox/done')) {
        return [
          { name: 'old.md', path: `${dir}/old.md`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 40 * 86400000) },
          { name: 'new.md', path: `${dir}/new.md`, isDirectory: false, isFile: true, size: 10, mtime: new Date(now - 1 * 86400000) },
        ];
      }
      return [];
    });
    // statSync mtime alternates based on path
    (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation((p: string): StatInfo => ({
      size: 10,
      mtime: new Date(p.includes('old.md') ? now - 40 * 86400000 : now - 1 * 86400000),
      ctime: new Date(),
      isDirectory: false,
      isFile: true,
    }));
    const writes: Array<{ type: string; cols: string[] }> = [];
    const audit: AuditLog = { write: (t, ...c) => writes.push({ type: t, cols: c.map(String) }) };

    await runRetentionCleanup({ motionDir: '/m', fs, audit, maxDays: { inbox: 30 } });

    const deletedCalls = (fs.deleteSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(deletedCalls.length).toBe(1);
    expect(deletedCalls[0][0]).toContain('old.md');
    expect(writes.some(w => w.type === CRON_AUDIT_EVENTS.RETENTION_CLEANUP)).toBe(true);
  });

  it('反向 2: no maxDays configured → skip', async () => {
    const fs = mockFs({ exists: true });
    const audit: AuditLog = { write: vi.fn() };

    await runRetentionCleanup({ motionDir: '/m', fs, audit, maxDays: {} });

    expect(fs.listSync).not.toHaveBeenCalled();
  });

  it('反向 3: directories inside target are skipped', async () => {
    const now = Date.now();
    const fs = mockFs({
      exists: true,
      entries: [
        { name: 'subdir', path: '/m/inbox/done/subdir', isDirectory: true, isFile: false, size: 0, mtime: new Date(now - 40 * 86400000) },
      ],
    });
    const audit: AuditLog = { write: vi.fn() };

    await runRetentionCleanup({ motionDir: '/m', fs, audit, maxDays: { inbox: 30 } });

    expect(fs.deleteSync).not.toHaveBeenCalled();
  });
});
