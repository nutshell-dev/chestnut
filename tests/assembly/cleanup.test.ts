/**
 * Assembly cleanup tests (cleanupOrphanedTemp)
 *
 * phase 1395: merged from cleanup-narrow-enoent.test.ts (phase 1032 / 1106 reverse cases)
 * 历史：phase397 自 tests/foundation/fs.test.ts 物理迁。
 *
 * 两 describe block:
 *  - 'cleanupOrphanedTemp' — 真 fs 集成 case (clean / atomic write 保护)
 *  - 'cleanupOrphanedTemp FS_NOT_FOUND narrow' — mock-fs 反向 case (FS_NOT_FOUND swallow / 其它 throw)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { cleanupOrphanedTemp } from '../../src/assembly/cleanup.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem, FileEntry } from '../../src/foundation/fs/types.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';

describe('cleanupOrphanedTemp', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should clean up orphaned temp files', async () => {
    // Create an orphaned temp file (simulating crash)
    const tempFile = path.join(tempDir, '.tmp_orphaned_123');
    await fs.writeFile(tempFile, 'orphaned content', 'utf-8');

    // Also create a regular file
    const regularFile = path.join(tempDir, 'regular.txt');
    await fs.writeFile(regularFile, 'regular content', 'utf-8');

    // Clean up temp files
    const nodeFs = new NodeFileSystem({ baseDir: tempDir });
    const cleaned = await cleanupOrphanedTemp(nodeFs, tempDir);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toBe(tempFile);

    // Regular file should still exist
    expect(await fs.readFile(regularFile, 'utf-8')).toBe('regular content');
  });

  it('should not leave partial files on crash (simulated)', async () => {
    const filePath = path.join(tempDir, 'atomic-test.txt');
    const originalContent = 'original';

    // Write original content
    await fs.writeFile(filePath, originalContent, 'utf-8');

    // Simulate crash during write by creating temp file but not renaming
    const tempFile = path.join(tempDir, '.tmp_crash_test');
    await fs.writeFile(tempFile, 'new content', 'utf-8');

    // Clean up temp files (simulating recovery on restart)
    const nodeFs2 = new NodeFileSystem({ baseDir: tempDir });
    await cleanupOrphanedTemp(nodeFs2, tempDir);

    // Original file should still have original content
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe(originalContent);
  });

  it('should skip temp files newer than olderThanMs to avoid runtime race', async () => {
    const now = Date.now();
    const oldTempFile = path.join(tempDir, '.tmp_orphaned_old');
    const newTempFile = path.join(tempDir, '.tmp_orphaned_new');

    await fs.writeFile(oldTempFile, 'old', 'utf-8');
    // Force mtime clearly older than boundary
    const oldMtime = new Date(now - 60_000);
    await fs.utimes(oldTempFile, oldMtime, oldMtime);

    await fs.writeFile(newTempFile, 'new', 'utf-8');
    // Keep newTempFile mtime at now (>= olderThanMs)

    const nodeFs = new NodeFileSystem({ baseDir: tempDir });
    const cleaned = await cleanupOrphanedTemp(nodeFs, tempDir, now);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toBe(oldTempFile);
    await expect(fs.access(newTempFile)).resolves.toBeUndefined();
    await expect(fs.access(oldTempFile)).rejects.toThrow();
  });
});

// Reverse cases: verify cleanupOrphanedTemp only swallows FS_NOT_FOUND
// and throws non-FS_NOT_FOUND errors so caller .catch + audit (assemble.ts:478-480)
// can truly emit CLEANUP_TEMP_FILES_FAILED.
describe('cleanupOrphanedTemp FS_NOT_FOUND narrow', () => {
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

  it('stat failure with olderThanMs → skips file instead of deleting', async () => {
    const mockFs = makeMockFs({
      list: vi.fn().mockResolvedValue([makeEntry('.tmp_file1', true)]),
      stat: vi.fn().mockRejectedValue(new Error('stat boom')),
    });

    const cleaned = await cleanupOrphanedTemp(mockFs, '/somedir', Date.now());
    expect(cleaned).toHaveLength(0);
    expect(mockFs.delete).not.toHaveBeenCalled();
  });
});
