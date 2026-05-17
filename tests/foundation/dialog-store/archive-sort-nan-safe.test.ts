/**
 * Archive sort NaN-safe — reverse test for phase 903 B3
 *
 * Non-numeric prefix .json files must be skipped in archive sort.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockAudit() {
  return { write: vi.fn() };
}

function makeMockFs(opts: {
  currentContent: string;
  archives?: Array<{ name: string; content: string }>;
}): FileSystem {
  const archiveMap = new Map(opts.archives?.map(a => [`dialog/archive/${a.name}`, a.content]));
  return {
    read: vi.fn(async (p: string) => {
      if (p === 'dialog/current.json') return opts.currentContent;
      if (archiveMap.has(p)) return archiveMap.get(p)!;
      const err = new Error(`ENOENT: ${p}`) as any;
      err.code = 'ENOENT';
      throw err;
    }),
    list: vi.fn(async (p: string) => {
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

describe('DialogStore archive sort NaN-safe (phase 903 B3)', () => {
  it('skips non-numeric prefix .json files in loadLatestArchive', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentContent: '{ broken json',
      archives: [
        {
          name: '1700000001.json',
          content: JSON.stringify(makeSession({
            clawId: 'c1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            systemPrompt: 'sp',
            messages: [{ role: 'user', content: 'latest' }],
          })),
        },
        {
          name: 'notes.json',
          content: '{}',
        },
        {
          name: '1700000000.json',
          content: JSON.stringify(makeSession({
            clawId: 'c1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            systemPrompt: 'sp',
            messages: [{ role: 'user', content: 'older' }],
          })),
        },
        {
          name: 'meta.json',
          content: '{}',
        },
      ],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    const result = await (store as any).loadLatestArchive();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('1700000001.json');
    expect(result!.session.messages[0].content).toBe('latest');
  });
});
