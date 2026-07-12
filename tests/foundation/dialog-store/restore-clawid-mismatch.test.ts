import { describe, it, expect, vi } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { restoreMessages } from '../../../src/foundation/dialog-store/restore.js';
import { MarkerNotFoundError } from '../../../src/foundation/dialog-store/store.js';
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

describe('restoreMessages clawId consistency (phase 921)', () => {
  it('skips archive with mismatched clawId and continues searching', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentContent: JSON.stringify(makeSession({
        clawId: 'current-claw',
        messages: [{ role: 'user', content: 'hi' }],
      })),
      archives: [
        {
          name: '3000_claw-b.json',
          content: JSON.stringify(makeSession({
            clawId: 'claw-b',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            messages: [
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'test', input: {} }] },
            ],
          })),
        },
        {
          name: '2000_claw-a.json',
          content: JSON.stringify(makeSession({
            clawId: 'claw-a',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            messages: [
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'test', input: {} }] },
            ],
          })),
        },
      ],
    });

    const result = await restoreMessages(
      fs,
      'dialog/current.json',
      'dialog/archive',
      { clawId: 'claw-a', toolUseId: 'tool-1' },
      false,
      audit as unknown as AuditLog,
    );

    expect(result.meta.foundIn).toBe('archive');
    expect(result.meta.foundFile).toBe('2000_claw-a.json');
  });

  it('skips current.json with mismatched clawId and falls through to archive', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentContent: JSON.stringify(makeSession({
        clawId: 'wrong-claw',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'test', input: {} }] },
        ],
      })),
      archives: [
        {
          name: '2000_right-claw.json',
          content: JSON.stringify(makeSession({
            clawId: 'right-claw',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            messages: [
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'test', input: {} }] },
            ],
          })),
        },
      ],
    });

    const result = await restoreMessages(
      fs,
      'dialog/current.json',
      'dialog/archive',
      { clawId: 'right-claw', toolUseId: 'tool-1' },
      false,
      audit as unknown as AuditLog,
    );

    expect(result.meta.foundIn).toBe('archive');
    expect(result.meta.foundFile).toBe('2000_right-claw.json');
  });

  it('throws MarkerNotFoundError when only archive has mismatched clawId', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentContent: JSON.stringify(makeSession({
        clawId: 'current-claw',
        messages: [{ role: 'user', content: 'hi' }],
      })),
      archives: [
        {
          name: '2000_claw-b.json',
          content: JSON.stringify(makeSession({
            clawId: 'claw-b',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            messages: [
              { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'test', input: {} }] },
            ],
          })),
        },
      ],
    });

    await expect(restoreMessages(
      fs,
      'dialog/current.json',
      'dialog/archive',
      { clawId: 'claw-a', toolUseId: 'tool-1' },
      false,
      audit as unknown as AuditLog,
    )).rejects.toThrow(MarkerNotFoundError);
  });
});
