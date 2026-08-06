import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

// Mock fs.rename/renameSync to throw EXDEV for paths containing 'exdev-src';
// all other fs APIs pass through to the real implementation.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      rename: vi.fn(async (src: string, dst: string) => {
        if (src.includes('exdev-src')) {
          throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        }
        return actual.promises.rename(src, dst);
      }),
    },
    renameSync: vi.fn((src: string, dst: string) => {
      if (src.includes('exdev-src')) {
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      }
      return actual.renameSync(src, dst);
    }),
  };
});

async function setup(): Promise<{ tmpDir: string; nodeFs: NodeFileSystem }> {
  const tmpDir = fsSync.realpathSync(await createTrackedTempDir('fs-exdev-fallback-'));
  const nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  return { tmpDir, nodeFs };
}

describe('EXDEV fallback', () => {
  let actualFs: typeof import('fs');

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof import('fs')>('fs');
    vi.restoreAllMocks();
  });

  describe('moveFile', () => {
    it('copies a file across filesystems when rename throws EXDEV', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcPath = path.join(tmpDir, 'exdev-src-file.txt');
      const dstPath = path.join(tmpDir, 'exdev-dst-file.txt');
      await actualFs.promises.writeFile(srcPath, 'hello world', 'utf-8');

      await nodeFs.move('exdev-src-file.txt', 'exdev-dst-file.txt');

      await expect(actualFs.promises.access(srcPath).then(() => true, () => false)).resolves.toBe(false);
      expect(await actualFs.promises.readFile(dstPath, 'utf-8')).toBe('hello world');

      await cleanupTempDir(tmpDir);
    });

    it('throws size mismatch and preserves src when copy is truncated', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcPath = path.join(tmpDir, 'exdev-src-file.txt');
      const dstPath = path.join(tmpDir, 'exdev-dst-file.txt');
      await actualFs.promises.writeFile(srcPath, 'hello world', 'utf-8');

      vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst) => {
        const content = await actualFs.promises.readFile(src as string, 'utf-8');
        await actualFs.promises.writeFile(dst as string, content.slice(0, 2), 'utf-8');
      });

      await expect(nodeFs.move('exdev-src-file.txt', 'exdev-dst-file.txt')).rejects.toThrow(
        /moveFile EXDEV size mismatch/,
      );
      expect(await actualFs.promises.readFile(srcPath, 'utf-8')).toBe('hello world');

      await cleanupTempDir(tmpDir);
    });

    it('rejects directories with a clear guidance error', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcDir = path.join(tmpDir, 'exdev-src-dir');
      await actualFs.promises.mkdir(path.join(srcDir, 'nested'), { recursive: true });
      await actualFs.promises.writeFile(path.join(srcDir, 'nested', 'file.txt'), 'x', 'utf-8');

      await expect(nodeFs.move('exdev-src-dir', 'exdev-dst-dir')).rejects.toThrow(
        /moveFile only supports files; use moveDir\(\) for directories/,
      );
      expect(await actualFs.promises.access(srcDir).then(() => true, () => false)).toBe(true);

      await cleanupTempDir(tmpDir);
    });
  });

  describe('moveSync', () => {
    it('copies a file across filesystems when renameSync throws EXDEV', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcPath = path.join(tmpDir, 'exdev-src-file.txt');
      const dstPath = path.join(tmpDir, 'exdev-dst-file.txt');
      await actualFs.promises.writeFile(srcPath, 'hello world', 'utf-8');

      nodeFs.moveSync('exdev-src-file.txt', 'exdev-dst-file.txt');

      expect(actualFs.existsSync(srcPath)).toBe(false);
      expect(actualFs.readFileSync(dstPath, 'utf-8')).toBe('hello world');

      await cleanupTempDir(tmpDir);
    });

    it('throws size mismatch and preserves src when copy is truncated', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcPath = path.join(tmpDir, 'exdev-src-file.txt');
      const dstPath = path.join(tmpDir, 'exdev-dst-file.txt');
      await actualFs.promises.writeFile(srcPath, 'hello world', 'utf-8');

      vi.spyOn(fsSync, 'copyFileSync').mockImplementation((src, dst) => {
        const content = actualFs.readFileSync(src as string, 'utf-8');
        actualFs.writeFileSync(dst as string, content.slice(0, 2), 'utf-8');
      });

      expect(() => nodeFs.moveSync('exdev-src-file.txt', 'exdev-dst-file.txt')).toThrow(
        /moveSync EXDEV size mismatch/,
      );
      expect(await actualFs.promises.readFile(srcPath, 'utf-8')).toBe('hello world');

      await cleanupTempDir(tmpDir);
    });
  });

  describe('moveDir', () => {
    it('recursively copies a directory across filesystems when rename throws EXDEV', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcDir = path.join(tmpDir, 'exdev-src-dir');
      await actualFs.promises.mkdir(path.join(srcDir, 'nested'), { recursive: true });
      await actualFs.promises.writeFile(path.join(srcDir, 'nested', 'file.txt'), 'hello', 'utf-8');
      const dstDir = path.join(tmpDir, 'exdev-dst-dir');

      await nodeFs.moveDir('exdev-src-dir', 'exdev-dst-dir');

      expect(await actualFs.promises.access(srcDir).then(() => true, () => false)).toBe(false);
      expect(await actualFs.promises.readFile(path.join(dstDir, 'nested', 'file.txt'), 'utf-8')).toBe('hello');

      await cleanupTempDir(tmpDir);
    });

    it('throws size mismatch and preserves src when dst is larger than src', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcDir = path.join(tmpDir, 'exdev-src-dir');
      await actualFs.promises.mkdir(srcDir, { recursive: true });
      await actualFs.promises.writeFile(path.join(srcDir, 'file.txt'), 'hello world', 'utf-8');

      vi.spyOn(fs, 'cp').mockImplementation(async (src, dst, options) => {
        await actualFs.promises.cp(src as string, dst as string, options);
        await actualFs.promises.writeFile(path.join(dst as string, 'extra.txt'), 'extra', 'utf-8');
      });

      await expect(nodeFs.moveDir('exdev-src-dir', 'exdev-dst-dir')).rejects.toThrow(
        /moveDir EXDEV size mismatch/,
      );
      expect(await actualFs.promises.access(path.join(srcDir, 'file.txt')).then(() => true, () => false)).toBe(true);

      await cleanupTempDir(tmpDir);
    });
  });

  describe('moveDirSync', () => {
    it('recursively copies a directory across filesystems when renameSync throws EXDEV', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcDir = path.join(tmpDir, 'exdev-src-dir');
      await actualFs.promises.mkdir(path.join(srcDir, 'nested'), { recursive: true });
      await actualFs.promises.writeFile(path.join(srcDir, 'nested', 'file.txt'), 'hello', 'utf-8');
      const dstDir = path.join(tmpDir, 'exdev-dst-dir');

      nodeFs.moveDirSync('exdev-src-dir', 'exdev-dst-dir');

      expect(actualFs.existsSync(srcDir)).toBe(false);
      expect(actualFs.readFileSync(path.join(dstDir, 'nested', 'file.txt'), 'utf-8')).toBe('hello');

      await cleanupTempDir(tmpDir);
    });

    it('throws size mismatch and preserves src when dst is larger than src', async () => {
      const { tmpDir, nodeFs } = await setup();
      const srcDir = path.join(tmpDir, 'exdev-src-dir');
      await actualFs.promises.mkdir(srcDir, { recursive: true });
      await actualFs.promises.writeFile(path.join(srcDir, 'file.txt'), 'hello world', 'utf-8');

      vi.spyOn(fsSync, 'cpSync').mockImplementation((src, dst, options) => {
        actualFs.cpSync(src as string, dst as string, options);
        actualFs.writeFileSync(path.join(dst as string, 'extra.txt'), 'extra');
      });

      expect(() => nodeFs.moveDirSync('exdev-src-dir', 'exdev-dst-dir')).toThrow(
        /moveDirSync EXDEV size mismatch/,
      );
      expect(actualFs.existsSync(path.join(srcDir, 'file.txt'))).toBe(true);

      await cleanupTempDir(tmpDir);
    });
  });

  it('moveFile still renames a directory on the same filesystem (no EXDEV)', async () => {
    const { tmpDir, nodeFs } = await setup();
    const srcDir = path.join(tmpDir, 'samefs-src-dir');
    await actualFs.promises.mkdir(srcDir, { recursive: true });
    await actualFs.promises.writeFile(path.join(srcDir, 'file.txt'), 'hello', 'utf-8');
    const dstDir = path.join(tmpDir, 'samefs-dst-dir');

    await nodeFs.move('samefs-src-dir', 'samefs-dst-dir');

    expect(await actualFs.promises.access(srcDir).then(() => true, () => false)).toBe(false);
    expect(await actualFs.promises.readFile(path.join(dstDir, 'file.txt'), 'utf-8')).toBe('hello');

    await cleanupTempDir(tmpDir);
  });
});
