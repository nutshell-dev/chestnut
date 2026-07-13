/**
 * Phase 984 — DialogStore I/O vs corruption separation tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeSession } from '../../helpers/session-fixtures.js';

function makeMockAudit() {
  return { write: vi.fn() };
}

function makeMockFs(opts: {
  currentReadError?: Error;
  currentContent?: string;
  archives?: Array<{ name: string; content: string }>;
  listError?: Error;
  existsReturns?: boolean;
}): FileSystem {
  const archiveMap = new Map(opts.archives?.map(a => [`dialog/archive/${a.name}`, a.content]));
  return {
    read: vi.fn(async (p: string) => {
      if (p === 'dialog/current.json') {
        if (opts.currentReadError) throw opts.currentReadError;
        if (opts.currentContent !== undefined) return opts.currentContent;
        const err = new Error(`ENOENT: ${p}`) as any;
        err.code = 'ENOENT';
        throw err;
      }
      if (archiveMap.has(p)) return archiveMap.get(p)!;
      const err = new Error(`ENOENT: ${p}`) as any;
      err.code = 'ENOENT';
      throw err;
    }),
    list: vi.fn(async (p: string) => {
      if (opts.listError) throw opts.listError;
      if (p === 'dialog/archive') {
        return (opts.archives ?? []).map((a, i) => ({
          name: a.name,
          path: `dialog/archive/${a.name}`,
          isFile: true,
          isDirectory: false,
          size: a.content.length,
          mtime: new Date(1000 + i),
        } as FileEntry));
      }
      return [];
    }),
    ensureDir: vi.fn(async () => {}),
    writeAtomic: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    append: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => opts.existsReturns ?? false),
    isDirectory: vi.fn(async () => false),
    stat: vi.fn(async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    writeAtomicSync: vi.fn(() => {}),
    writeExclusiveSync: vi.fn(() => {}),
    readSync: vi.fn(() => ''),
    readBytesSync: vi.fn(() => Buffer.from('')),
    appendSync: vi.fn(() => {}),
    statSync: vi.fn(() => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
    moveSync: vi.fn(() => {}),
    existsSync: vi.fn(() => false),
    ensureDirSync: vi.fn(() => {}),
    listSync: vi.fn(() => []),
    deleteSync: vi.fn(() => {}),
    resolve: vi.fn((p: string) => `/base/${p}`),
  } as unknown as FileSystem;
}

describe('DialogStore I/O vs corruption separation (phase 984)', () => {
  it('propagates current.json I/O error without isolating the file', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentReadError: Object.assign(new Error('EIO'), { code: 'EIO' }),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('io_error');
    expect(result.error).toContain('EIO');
    expect(fs.move).not.toHaveBeenCalled();
    const loadFailed = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.LOAD_FAILED);
    expect(loadFailed.length).toBe(1);
    expect(loadFailed[0][1]).toContain('file=current.json');
  });

  it('isolates corrupted current.json to a timestamped filename', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ currentContent: 'not valid json {{{' });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('empty');
    expect(fs.move).toHaveBeenCalledWith(
      'dialog/current.json',
      expect.stringMatching(/dialog\/current\.json\.corrupted\.\d+_[a-z0-9]+/),
    );
    const corrupted = audit.write.mock.calls.filter(
      (c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED && c[1] && c[1].includes('file=current.json'),
    );
    expect(corrupted.length).toBeGreaterThanOrEqual(1);
  });

  it('propagates archive directory read failure instead of cold-starting', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      listError: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    await expect((store as any).loadLatestArchive()).rejects.toThrow('EACCES');
  });

  it('retries current.json when corruptedPoisoned and the file reappears', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      existsReturns: true,
      currentContent: JSON.stringify(makeSession({
        clawId: 'c1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        systemPrompt: 'sp',
        messages: [{ role: 'user', content: 'hello' }],
      })),
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');
    (store as any).corruptedPoisoned = true;

    const result = await store.load();

    expect(result.source).toBe('current');
    expect((store as any).corruptedPoisoned).toBe(false);
  });
});
