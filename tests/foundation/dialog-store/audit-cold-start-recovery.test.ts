/**
 * Audit cold-start / empty-archive / all-corrupted coverage — phase 1054 P3.1-P3.3
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
  currentExists?: boolean;
  currentContent?: string;
  archives?: Array<{ name: string; content: string; isFile?: boolean }>;
  listThrows?: boolean;
}): FileSystem {
  const archiveMap = new Map(opts.archives?.map(a => [`dialog/archive/${a.name}`, a.content]));
  return {
    read: vi.fn(async (p: string) => {
      if (p === 'dialog/current.json') {
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
      if (opts.listThrows) {
        const err = new Error('ENOTDIR') as any;
        err.code = 'ENOTDIR';
        throw err;
      }
      if (p === 'dialog/archive') {
        return (opts.archives ?? []).map((a, i) => ({
          name: a.name,
          path: `dialog/archive/${a.name}`,
          isFile: a.isFile ?? true,
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
    exists: vi.fn(async () => false),
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

describe('DialogStore audit cold-start / archive recovery (phase 1054)', () => {
  it('emits COLD_START when no current.json and no archive', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ currentExists: false });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('empty');
    const coldStartCalls = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.COLD_START);
    expect(coldStartCalls.length).toBe(1);
  });

  it('emits ARCHIVE_EMPTY when archive dir exists but has no .json files', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({ currentExists: false, archives: [] });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('empty');
    const emptyCalls = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.ARCHIVE_EMPTY);
    expect(emptyCalls.length).toBe(1);
  });

  it('emits ARCHIVE_ALL_CORRUPTED when all .json archives are unparseable', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentExists: false,
      archives: [
        { name: '1700000001_abc.json', content: 'not json' },
        { name: '1700000000_def.json', content: '{ broken' },
      ],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('empty');
    const allCorruptedCalls = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.ARCHIVE_ALL_CORRUPTED);
    expect(allCorruptedCalls.length).toBe(1);
    expect(allCorruptedCalls[0][1]).toContain('scanned=2');
  });

  it('does not emit ARCHIVE_EMPTY when a valid archive is found', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentExists: false,
      archives: [
        {
          name: '1700000001_abc.json',
          content: JSON.stringify(makeSession({
            clawId: 'c1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            systemPrompt: 'sp',
            messages: [{ role: 'user', content: 'hello' }],
          })),
        },
      ],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('archive');
    const emptyCalls = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.ARCHIVE_EMPTY);
    expect(emptyCalls.length).toBe(0);
    const recoveredCalls = audit.write.mock.calls.filter((c: any[]) => c[0] === DIALOG_AUDIT_EVENTS.RECOVERED);
    expect(recoveredCalls.length).toBe(1);
  });

  it('caches createdAt from archive recovery', async () => {
    const audit = makeMockAudit();
    const createdAt = '2024-06-15T12:00:00Z';
    const fs = makeMockFs({
      currentExists: false,
      archives: [
        {
          name: '1700000001_abc.json',
          content: JSON.stringify(makeSession({
            clawId: 'c1',
            createdAt,
            updatedAt: '2024-01-01T00:00:00Z',
            systemPrompt: 'sp',
            messages: [{ role: 'user', content: 'hello' }],
          })),
        },
      ],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await store.load();

    expect(result.source).toBe('archive');
    expect(result.session.createdAt).toBe(createdAt);

    // Verify createdAt is cached: subsequent save() should reuse it
    await store.save({ systemPrompt: 'new', messages: [], toolsForLLM: [] });
    const writeCall = fs.writeAtomic.mock.calls.find((c: any[]) => c[0] === 'dialog/current.json');
    expect(writeCall).toBeDefined();
    const savedData = JSON.parse(writeCall![1] as string);
    expect(savedData.createdAt).toBe(createdAt);
  });
});
