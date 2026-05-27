import { describe, it, expect, vi } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockAudit() {
  return { write: vi.fn() };
}

function makeMockFs(opts: {
  currentContent: string;
  moveThrows?: boolean;
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
    move: vi.fn(async () => {
      if (opts.moveThrows) {
        const err = new Error('EPERM: not permitted') as any;
        err.code = 'EPERM';
        throw err;
      }
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

describe('DialogStore re-entry storm', () => {
  it('rename 失败后下次 load 不再尝试 parse', async () => {
    const audit = makeMockAudit();
    const fs = makeMockFs({
      currentContent: '{ invalid json',
      moveThrows: true,
      archives: [
        {
          name: '1000_recover.json',
          content: JSON.stringify(makeSession({
            clawId: 'c1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            systemPrompt: 'sp',
            messages: [{ role: 'user', content: 'hi' }],
          })),
        },
      ],
    });
    const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

    // act 1: 首次 load → audit CORRUPTED + CORRUPTED_ISOLATE_FAILED + 走 archive
    const r1 = await store.load();
    expect(r1.source).toBe('archive');
    expect(r1.session.messages).toHaveLength(1);

    const corruptedCalls = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED,
    );
    const isolateFailedCalls = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED_ISOLATE_FAILED,
    );
    expect(corruptedCalls).toHaveLength(1);
    expect(isolateFailedCalls).toHaveLength(1);

    // act 2: 二次 load → 0 NEW CORRUPTED audit / 直接走 archive
    audit.write.mockClear();
    const r2 = await store.load();
    expect(r2.source).toBe('archive');
    expect(r2.session.messages).toHaveLength(1);

    const corruptedCalls2 = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED,
    );
    expect(corruptedCalls2).toHaveLength(0);

    const recoveredCalls2 = audit.write.mock.calls.filter(
      (c: unknown[]) => c[0] === DIALOG_AUDIT_EVENTS.RECOVERED,
    );
    expect(recoveredCalls2).toHaveLength(1);
  });
});
