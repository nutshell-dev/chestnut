/**
 * Assembly cleanup narrow tests (phase 1032 / phase 1106)
 *
 * Reverse cases: verify cleanupOrphanedTemp only swallows FS_NOT_FOUND
 * and throws non-FS_NOT_FOUND errors so caller .catch + audit (assemble.ts:478-480)
 * can truly emit CLEANUP_TEMP_FILES_FAILED.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FileSystem, FileEntry } from '../../src/foundation/fs/types.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';
import { cleanupOrphanedTemp } from '../../src/assembly/cleanup.js';

function makeMockFs(overrides?: Partial<FileSystem>): FileSystem {
  return {
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    read: vi.fn(),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    writeAtomicSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readSync: vi.fn(),
    readBytesSync: vi.fn(),
    appendSync: vi.fn(),
    statSync: vi.fn(),
    moveSync: vi.fn(),
    existsSync: vi.fn(),
    ensureDirSync: vi.fn(),
    listSync: vi.fn(),
    deleteSync: vi.fn(),
    resolve: vi.fn((p: string) => p),
    ...overrides,
  } as unknown as FileSystem;
}

function makeEntry(name: string, isFile: boolean): FileEntry {
  return {
    name,
    path: name,
    isDirectory: !isFile,
    isFile,
    size: 0,
    mtime: new Date(),
  };
}

describe('cleanupOrphanedTemp FS_NOT_FOUND narrow', () => {
  it('list FS_NOT_FOUND → resolves [] (first-run dir absent acceptable)', async () => {
    const mockFs = makeMockFs({
      list: vi.fn().mockRejectedValue(new FileNotFoundError('/nonexistent')),
    });
    await expect(cleanupOrphanedTemp(mockFs, '/nonexistent')).resolves.toEqual([]);
  });

  it('list EACCES → throws (caller .catch can audit)', async () => {
    const mockFs = makeMockFs({
      list: vi.fn().mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' })),
    });
    await expect(cleanupOrphanedTemp(mockFs, '/protected')).rejects.toThrow();
  });

  it('delete FS_NOT_FOUND → continues (concurrent race acceptable)', async () => {
    const mockFs = makeMockFs({
      list: vi.fn().mockResolvedValue([
        makeEntry('.tmp_file1', true),
        makeEntry('.tmp_file2', true),
      ]),
    });
    let callCount = 0;
    mockFs.delete = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new FileNotFoundError('.tmp_file1');
      }
      return undefined;
    });

    const cleaned = await cleanupOrphanedTemp(mockFs, '/somedir');
    expect(cleaned).toHaveLength(1);
    expect(mockFs.delete).toHaveBeenCalledTimes(2);
  });

  it('delete EIO → throws (caller .catch can audit)', async () => {
    const mockFs = makeMockFs({
      list: vi.fn().mockResolvedValue([makeEntry('.tmp_file1', true)]),
      delete: vi.fn().mockRejectedValue(Object.assign(new Error('i/o error'), { code: 'EIO' })),
    });

    await expect(cleanupOrphanedTemp(mockFs, '/somedir')).rejects.toThrow();
  });
});
