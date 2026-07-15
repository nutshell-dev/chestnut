/**
 * Archive invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - archive-sort-nan-safe.test.ts
 *  - phase920-archive-serialize.test.ts
 *  - phase920-list-archive-error.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSession } from '../../helpers/session-fixtures.js';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { listArchiveDialogFiles } from '../../../src/foundation/dialog-store/list-archive.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

/**
 * Archive sort NaN-safe — reverse test for phase 903 B3
 *
 * Non-numeric prefix .json files must be skipped in archive sort.
 */
describe('archive-sort-nan-safe', () => {
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
});

/**
 * Phase 920 Step B: archive serialization + state reset
 */
describe('phase920-archive-serialize', () => {
  describe('DialogStore archive (phase 920)', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    let audit: ReturnType<typeof makeAudit>;
    let store: DialogStore;
    const filename = 'current.json';
    const clawId = 'test-claw';

    beforeEach(async () => {
      vi.restoreAllMocks();
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
      audit = makeAudit();
      store = new DialogStore(fs, '', audit.audit, filename, clawId);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('archive waits for pending save before moving', async () => {
      const originalWrite = fs.writeAtomic.bind(fs);
      const originalMove = fs.move.bind(fs);
      const order: string[] = [];

      let releaseSave!: () => void;
      let saveEntered = false;

      vi.spyOn(fs, 'writeAtomic').mockImplementation(async (filePath, content) => {
        saveEntered = true;
        order.push('save');
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return originalWrite(filePath, content);
      });

      vi.spyOn(fs, 'move').mockImplementation(async (fromPath, toPath) => {
        order.push('archive');
        return originalMove(fromPath, toPath);
      });

      const savePromise = store.save({
        systemPrompt: 'during-save',
        messages: [{ role: 'user', content: 'hello' }],
        toolsForLLM: [],
      });

      // Ensure save has entered its serialized write before we call archive.
      await vi.waitUntil(() => saveEntered, { timeout: 1000 });

      const archivePromise = store.archive();

      // Give archive a chance to run if it were not properly serialized.
      const ARCHIVE_RACE_WINDOW_MS = 30; // derive: short enough for test speed, long enough for racy archive to execute
      await new Promise((resolve) => setTimeout(resolve, ARCHIVE_RACE_WINDOW_MS));
      expect(order).toEqual(['save']);

      releaseSave();
      await Promise.all([savePromise, archivePromise]);

      expect(order).toEqual(['save', 'archive']);

      // After archive, current.json must be gone (no duplicate left behind).
      const hasCurrent = await store.hasCurrent();
      expect(hasCurrent).toBe(false);

      // And exactly one archive file should exist.
      const archives = await store.listArchives();
      expect(archives).toHaveLength(1);
    });

    it('resets prevMessagesLength after archive', async () => {
      // Create current.json so archive() can move it.
      await store.save({
        systemPrompt: 'pre-archive',
        messages: [{ role: 'user', content: 'msg' }],
        toolsForLLM: [],
      });

      // Simulate stale length cache from a previous long session.
      (store as any).prevMessagesLength = 500;

      await store.archive();

      expect((store as any).prevMessagesLength).toBe(0);
    });
  });
});

/**
 * Phase 920 Step B: listArchiveDialogFiles error propagation
 */
describe('phase920-list-archive-error', () => {
  function makeEaccesError(): Error {
    const err = new Error('EACCES: permission denied, scandir');
    (err as NodeJS.ErrnoException).code = 'EACCES';
    return err;
  }

  describe('listArchiveDialogFiles (phase 920)', () => {
    it('throws on EACCES instead of returning an empty list', async () => {
      const mockFs = {
        existsSync: vi.fn(() => true),
        list: vi.fn(async () => {
          throw makeEaccesError();
        }),
        stat: vi.fn(async () => ({ size: 0, mtime: new Date(), ctime: new Date(), isFile: true, isDirectory: false })),
      } as unknown as FileSystem;

      await expect(listArchiveDialogFiles(mockFs, '/any/claw')).rejects.toThrow('EACCES');
      expect(mockFs.list).toHaveBeenCalledTimes(1);
    });

    it('skips a file that vanished between list and stat (TOCTOU ENOENT)', async () => {
      const mockFs = {
        existsSync: vi.fn(() => true),
        list: vi.fn(async () => [
          { name: '1700000000_abc.json', path: 'dialog/archive/1700000000_abc.json', isFile: true, isDirectory: false, size: 10, mtime: new Date() },
          { name: 'gone.json', path: 'dialog/archive/gone.json', isFile: true, isDirectory: false, size: 10, mtime: new Date() },
        ]),
        stat: vi.fn(async (p: string) => {
          if (p.endsWith('gone.json')) {
            const err = new Error('ENOENT');
            (err as NodeJS.ErrnoException).code = 'ENOENT';
            throw err;
          }
          return { size: 10, mtime: new Date(1700000000000), ctime: new Date(), isFile: true, isDirectory: false };
        }),
      } as unknown as FileSystem;

      const refs = await listArchiveDialogFiles(mockFs, '/any/claw');
      expect(refs).toHaveLength(1);
      expect(refs[0].name).toBe('1700000000_abc.json');
    });
  });
});
