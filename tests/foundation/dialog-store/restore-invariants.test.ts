/**
 * Restore invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - restore-prefix-corrupted.test.ts
 *  - restore.test.ts
 *  - restore-clawid-mismatch.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { DialogStore, MarkerNotFoundError } from '../../../src/foundation/dialog-store/store.js';
import { restoreMessages } from '../../../src/foundation/dialog-store/restore.js';
import { DialogIOError } from '../../../src/foundation/dialog-store/errors.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

describe('restore-prefix-corrupted', () => {
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

  describe('DialogStore restorePrefix corrupted', () => {
    it('restorePrefix current.json 损坏时 audit CORRUPTED', async () => {
      const audit = makeMockAudit();
      const fs = makeMockFs({
        currentContent: '{ broken json',
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

      await expect(
        store.restorePrefix({ clawId: 'c1', toolUseId: 'nonexistent' }),
      ).rejects.toThrow(MarkerNotFoundError);

      const corruptedCalls = audit.write.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === DIALOG_AUDIT_EVENTS.CORRUPTED &&
          c.includes('context=restore_prefix'),
      );
      expect(corruptedCalls.length).toBe(1);
    });

    it('restorePrefix current.json EIO 传播并 audit RESTORE_IO_ERROR', async () => {
      const audit = makeMockAudit();
      const fs = makeMockFs({ currentContent: '' });
      fs.read = vi.fn(async (p: string) => {
        if (p === 'dialog/current.json') {
          const err = new Error('EIO: i/o error, read') as any;
          err.code = 'EIO';
          throw err;
        }
        const err = new Error(`ENOENT: ${p}`) as any;
        err.code = 'ENOENT';
        throw err;
      });
      const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

      await expect(
        store.restorePrefix({ clawId: 'c1', toolUseId: 'nonexistent' }),
      ).rejects.toThrow('EIO');

      const ioErrorCalls = audit.write.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === DIALOG_AUDIT_EVENTS.RESTORE_IO_ERROR &&
          c.includes('file=current.json'),
      );
      expect(ioErrorCalls.length).toBe(1);
    });
  });
});

/**
 * Phase 984 — DialogStore restore I/O propagation tests.
 */
describe('restore', () => {
  function makeMockAudit() {
    return { write: vi.fn() };
  }

  function makeMockFs(opts: {
    currentReadError?: Error;
    currentContent?: string;
    archives?: Array<{ name: string; content: string }>;
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

  describe('DialogStore restore I/O propagation (phase 984)', () => {
    it('propagates current.json read I/O error instead of masking it as corruption', async () => {
      const audit = makeMockAudit();
      const fs = makeMockFs({
        currentReadError: Object.assign(new Error('EIO'), { code: 'EIO' }),
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

      await expect(
        store.restore({ clawId: 'c1', toolUseId: 'nonexistent' }),
      ).rejects.toThrow('EIO');
    });

    it('Phase 990: propagates DialogIOError from archive scan', async () => {
      const audit = makeMockAudit();
      const baseFs = makeMockFs({
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
      const fs = {
        ...baseFs,
        read: vi.fn(async (p: string) => {
          if (p === 'dialog/archive/1000_recover.json') {
            throw new DialogIOError('EIO', new Error('EIO'));
          }
          return baseFs.read(p);
        }),
      } as unknown as FileSystem;
      const store = new DialogStore(fs, 'dialog', audit as unknown as AuditLog, 'current.json', 'c1');

      await expect(
        store.restore({ clawId: 'c1', toolUseId: 'nonexistent' }),
      ).rejects.toBeInstanceOf(DialogIOError);
    });
  });
});

describe('restore-clawid-mismatch', () => {
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
});
