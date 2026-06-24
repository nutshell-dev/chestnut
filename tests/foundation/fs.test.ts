/**
 * FileSystem tests
 * 
 * Tests:
 * - writeAtomic: concurrent writes, crash recovery
 * - permissions: read/write restrictions
 * - watcher: file change events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsSync from 'fs';
import * as path from 'path';
import { promises as fs, promises as nativeFs } from 'fs';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn((...args: any[]) => actual.fsyncSync(...args)),
  };
});

import {
  NodeFileSystem,
  writeAtomic,
} from '../../src/foundation/fs/index.js';
import { PermissionError } from '../../src/core/permissions/errors.js';
import { FileNotFoundError } from '../../src/foundation/fs/types.js';

describe('FileSystem', () => {
  describe('writeAtomic', () => {
    let tempDir: string;
    
    beforeEach(async () => {
      tempDir = await createTempDir();
    });
    
    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });
    
    it('should write file atomically', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      const content = 'Hello, World!';
      
      await writeAtomic(filePath, content);
      
      const readContent = await fs.readFile(filePath, 'utf-8');
      expect(readContent).toBe(content);
    });
    
    it('should handle 100 concurrent writes to same file', async () => {
      const filePath = path.join(tempDir, 'concurrent.txt');
      
      // 100 concurrent writes
      const writes = Array.from({ length: 100 }, (_, i) => 
        writeAtomic(filePath, `content-${i}`)
      );
      
      await Promise.all(writes);
      
      // File should exist and contain valid content (one of the writes)
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toMatch(/^content-\d+$/);
      
      // No temp files should remain
      const files = await fs.readdir(tempDir);
      const tempFiles = files.filter(f => f.startsWith('.tmp_'));
      expect(tempFiles).toHaveLength(0);
    });
    
  });

  describe('NodeFileSystem', () => {
    let tempDir: string;
    let fs: NodeFileSystem;
    
    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
    });
    
    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });
    
    it('should read and write files', async () => {
      const content = 'test content';
      await fs.writeAtomic('test.txt', content);
      
      const readContent = await fs.read('test.txt');
      expect(readContent).toBe(content);
    });
    
    it('should create directories', async () => {
      await fs.ensureDir('subdir/nested');
      
      const stat = await fs.stat('subdir/nested');
      expect(stat.isDirectory).toBe(true);
    });
    
    it('should list directory contents', async () => {
      await fs.writeAtomic('file1.txt', 'content1');
      await fs.writeAtomic('file2.txt', 'content2');
      await fs.ensureDir('subdir');
      
      const entries = await fs.list('.', { includeDirs: true });
      
      expect(entries).toHaveLength(3);
      expect(entries.some(e => e.name === 'file1.txt' && e.isFile)).toBe(true);
      expect(entries.some(e => e.name === 'file2.txt' && e.isFile)).toBe(true);
      expect(entries.some(e => e.name === 'subdir' && e.isDirectory)).toBe(true);
    });
    
    it('should check file existence', async () => {
      await fs.writeAtomic('exists.txt', 'yes');
      
      expect(await fs.exists('exists.txt')).toBe(true);
      expect(await fs.exists('not-exists.txt')).toBe(false);
    });
    
    it('should throw FileNotFoundError for missing file', async () => {
      await expect(fs.read('missing.txt')).rejects.toThrow(FileNotFoundError);
    });
    
    it('should move files', async () => {
      await fs.writeAtomic('source.txt', 'original');

      await fs.move('source.txt', 'moved.txt');
      expect(await fs.exists('source.txt')).toBe(false);
      expect(await fs.read('moved.txt')).toBe('original');
    });
    
    it('should delete files and directories', async () => {
      await fs.writeAtomic('to-delete.txt', 'bye');
      await fs.ensureDir('to-delete-dir');
      
      await fs.delete('to-delete.txt');
      await fs.removeDir('to-delete-dir');
      
      expect(await fs.exists('to-delete.txt')).toBe(false);
      expect(await fs.exists('to-delete-dir')).toBe(false);
    });
  });
  
  describe('base-dir traversal guard', () => {
    let tempDir: string;
    let fs: NodeFileSystem;

    beforeEach(async () => {
      tempDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: tempDir });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('should allow read within baseDir', async () => {
      await fs.writeAtomic('test.txt', 'test');
      const content = await fs.read('test.txt');
      expect(content).toBe('test');
    });

    it('should throw PermissionError for path traversal attempts', async () => {
      await expect(fs.read('../etc/passwd')).rejects.toThrow(PermissionError);
    });

    it('should throw PermissionError for paths outside baseDir', async () => {
      const outsidePath = path.join(tempDir, '..', 'outside.txt');
      const relativeOutside = path.relative(tempDir, outsidePath);
      await expect(fs.read(relativeOutside)).rejects.toThrow(PermissionError);
    });
  });
  
  describe('FileSystem integration', () => {
    it('should be assignable to FileSystem interface', async () => {
      const tempDir = await createTempDir();
      
      try {
        // This tests structural typing - NodeFileSystem should satisfy FileSystem
        const fs: NodeFileSystem = new NodeFileSystem({
          baseDir: tempDir,
        });
        
        // TypeScript compile-time check
        expect(fs).toBeDefined();
        expect(typeof fs.read).toBe('function');
        expect(typeof fs.writeAtomic).toBe('function');
        expect(typeof fs.move).toBe('function');
      } finally {
        await cleanupTempDir(tempDir);
      }
    });
  });

  describe('symlink traversal protection', () => {
    let clawDir: string;
    let outsideDir: string;

    beforeEach(async () => {
      clawDir = await createTempDir();
      outsideDir = await createTempDir();
    });

    afterEach(async () => {
      await cleanupTempDir(clawDir);
      await cleanupTempDir(outsideDir);
    });

    it('should reject reads via symlink pointing outside baseDir', async () => {
      // Write a "secret" file outside baseDir
      await nativeFs.writeFile(path.join(outsideDir, 'secret.txt'), 'top secret');

      // Create a symlink inside baseDir pointing to the outside file
      await nativeFs.symlink(
        path.join(outsideDir, 'secret.txt'),
        path.join(clawDir, 'evil-link.txt')
      );

      const nodeFs = new NodeFileSystem({ baseDir: clawDir });

      await expect(nodeFs.read('evil-link.txt')).rejects.toThrow(PermissionError);
    });

    it('should allow reads of normal files within baseDir', async () => {
      await nativeFs.writeFile(path.join(clawDir, 'safe.txt'), 'safe content');

      const nodeFs = new NodeFileSystem({ baseDir: clawDir });

      const content = await nodeFs.read('safe.txt');
      expect(content).toBe('safe content');
    });

    it('should allow reads via symlink pointing within baseDir', async () => {
      // Target file inside baseDir
      await nativeFs.writeFile(path.join(clawDir, 'real.txt'), 'real content');
      // Symlink also inside baseDir
      await nativeFs.symlink(
        path.join(clawDir, 'real.txt'),
        path.join(clawDir, 'link.txt')
      );

      const nodeFs = new NodeFileSystem({ baseDir: clawDir });

      const content = await nodeFs.read('link.txt');
      expect(content).toBe('real content');
    });

    it('should reject writes via symlink pointing outside baseDir', async () => {
      const targetFile = path.join(outsideDir, 'target.txt');
      await nativeFs.writeFile(targetFile, 'original');

      await nativeFs.symlink(
        targetFile,
        path.join(clawDir, 'evil-write-link.txt')
      );

      const nodeFs = new NodeFileSystem({ baseDir: clawDir });

      await expect(nodeFs.writeAtomic('evil-write-link.txt', 'pwned')).rejects.toThrow(PermissionError);

      // Original file should be untouched
      const original = await nativeFs.readFile(targetFile, 'utf-8');
      expect(original).toBe('original');
    });
  });

  describe('NodeFileSystem readBytesSync (phase165)', () => {
    let fs: NodeFileSystem;
    let clawDir: string;

    beforeEach(async () => {
      clawDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: clawDir });
    });

    afterEach(async () => {
      await cleanupTempDir(clawDir);
    });

    it('读取 ASCII 文件的全字节范围与 readSync 结果一致', () => {
      fs.writeAtomicSync('ascii.txt', 'hello world');
      const size = fs.statSync('ascii.txt').size;
      const buf = fs.readBytesSync('ascii.txt', 0, size);
      expect(buf.toString('utf-8')).toBe('hello world');
      expect(buf.length).toBe(11);
    });

    it('读取字节范围 [start, end) 半开区间正确', () => {
      fs.writeAtomicSync('range.txt', 'abcdefgh');
      const buf = fs.readBytesSync('range.txt', 2, 5);
      expect(buf.toString('utf-8')).toBe('cde');
      expect(buf.length).toBe(3);
    });

    it('多字节 UTF-8 字符按字节边界切割时返回原始字节（不解码）', () => {
      // '中' 的 UTF-8 编码是 3 字节 E4 B8 AD
      fs.writeAtomicSync('utf8.txt', '中国');
      const size = fs.statSync('utf8.txt').size;
      expect(size).toBe(6);
      // 切到 '中' 的中间（读前 2 字节）——Buffer 必须是 E4 B8，不做任何解码替换
      const partial = fs.readBytesSync('utf8.txt', 0, 2);
      expect(partial.length).toBe(2);
      expect(partial[0]).toBe(0xe4);
      expect(partial[1]).toBe(0xb8);
    });

    it('文件不存在抛 FileNotFoundError', () => {
      expect(() => fs.readBytesSync('nonexistent.txt', 0, 10)).toThrow(FileNotFoundError);
    });

    it('end ≤ start 时返回空 Buffer 不抛错', () => {
      fs.writeAtomicSync('empty-range.txt', 'hello');
      expect(fs.readBytesSync('empty-range.txt', 3, 3).length).toBe(0);
      expect(fs.readBytesSync('empty-range.txt', 5, 2).length).toBe(0);
    });
  });

  describe('listSync (phase 610 / A.list-async-vs-sync)', () => {
    let fs: NodeFileSystem;
    let clawDir: string;

    beforeEach(async () => {
      clawDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: clawDir });
    });

    afterEach(async () => {
      await cleanupTempDir(clawDir);
    });

    it('path 字段相对 fs root（align list async）', () => {
      fs.ensureDirSync('a/b');
      fs.writeAtomicSync('a/b/c.txt', 'x');
      const entries = fs.listSync('a/b', { includeDirs: false });
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('a/b/c.txt');
    });

    it('recursive option 真生效', () => {
      fs.ensureDirSync('a/b');
      fs.writeAtomicSync('a/b/c.txt', 'deep');
      fs.writeAtomicSync('a/d.txt', 'shallow');
      const entries = fs.listSync('a', { recursive: true, includeDirs: false });
      const paths = entries.map(e => e.path);
      expect(paths).toContain('a/b/c.txt');
      expect(paths).toContain('a/d.txt');
    });

    it('recursive false 时只返回一层', () => {
      fs.ensureDirSync('a/b');
      fs.writeAtomicSync('a/b/c.txt', 'deep');
      fs.writeAtomicSync('a/d.txt', 'shallow');
      const entries = fs.listSync('a', { recursive: false, includeDirs: false });
      expect(entries.map(e => e.path)).toContain('a/d.txt');
      expect(entries.map(e => e.path)).not.toContain('a/b/c.txt');
    });

    it('recursive + includeDirs 同时生效', () => {
      fs.ensureDirSync('a/b');
      fs.writeAtomicSync('a/d.txt', 'shallow');
      const entries = fs.listSync('a', { recursive: true, includeDirs: true });
      const paths = entries.map(e => e.path);
      expect(paths).toContain('a/b');
      expect(paths).toContain('a/d.txt');
    });
  });

  describe('writeExclusiveSync deep-path mkdir (phase 948 site B)', () => {
    let fs: NodeFileSystem;
    let clawDir: string;

    beforeEach(async () => {
      clawDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: clawDir });
    });

    afterEach(async () => {
      await cleanupTempDir(clawDir);
    });

    it('deep path parent dir 不存在时自动 mkdir 不抛 ENOENT', () => {
      const deepPath = 'a/b/c/d/lock.pid';
      expect(() => fs.writeExclusiveSync(deepPath, 'content')).not.toThrow();
      expect(fsSync.existsSync(path.join(clawDir, deepPath))).toBe(true);
    });
  });

  describe('writeExclusiveSync fsync (phase 610 / A.writeExclusiveSync-fsync)', () => {
    let fs: NodeFileSystem;
    let clawDir: string;

    beforeEach(async () => {
      clawDir = await createTempDir();
      fs = new NodeFileSystem({ baseDir: clawDir });
      vi.mocked(fsSync.fsyncSync).mockClear();
    });

    afterEach(async () => {
      await cleanupTempDir(clawDir);
    });

    it('closeSync 前调用 fsyncSync', () => {
      fs.writeExclusiveSync('lock-test', 'pid=123');
      expect(vi.mocked(fsSync.fsyncSync)).toHaveBeenCalled();
    });
  });

});
