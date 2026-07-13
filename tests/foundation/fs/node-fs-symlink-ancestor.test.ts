/**
 * NodeFileSystem symlink ancestor traversal tests (Phase 978)
 *
 * Covers the P0 fix where a mid-path symlink combined with deep non-existent
 * ancestors could bypass containment by only checking the immediate parent.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { PathGuardError } from '../../../src/foundation/fs/types.js';

async function makeTmpDirs(prefix: string): Promise<{ baseDir: string; outsideDir?: string; cleanup: () => Promise<void> }> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const baseDir = path.join(tmpBase, 'safe');
  await fsp.mkdir(baseDir, { recursive: true });

  return {
    baseDir,
    cleanup: async () => {
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* ignore */ });
    },
  };
}

describe('NodeFileSystem symlink ancestor containment', () => {
  it('rejects write through mid-path symlink with deep non-existent ancestors', async () => {
    const { baseDir, cleanup } = await makeTmpDirs('nodefs-symlink-');
    const outsideDir = path.join(path.dirname(baseDir), 'outside');
    await fsp.mkdir(outsideDir, { recursive: true });
    try {
      const linkPath = path.join(baseDir, 'link');
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      const nodeFs = new NodeFileSystem({ baseDir });

      // /safe/link -> /outside
      // write('link/a/b/c/file.txt') should detect that 'link' resolves outside baseDir
      await expect(nodeFs.writeAtomic('link/a/b/c/file.txt', 'data'))
        .rejects.toThrow(PathGuardError);
    } finally {
      await cleanup();
    }
  });

  it('allows write through mid-path directory inside base with deep non-existent ancestors', async () => {
    const { baseDir, cleanup } = await makeTmpDirs('nodefs-safe-dir-');
    try {
      await fsp.mkdir(path.join(baseDir, 'inner'), { recursive: true });

      const nodeFs = new NodeFileSystem({ baseDir });

      await expect(nodeFs.writeAtomic('inner/a/b/c/file.txt', 'data'))
        .resolves.toBeUndefined();

      const written = await fsp.readFile(path.join(baseDir, 'inner', 'a', 'b', 'c', 'file.txt'), 'utf-8');
      expect(written).toBe('data');
    } finally {
      await cleanup();
    }
  });

  it('rejects write when baseDir ancestor is a symlink to outside', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodefs-base-ancestor-'));
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodefs-outside-'));
    try {
      const linkPath = path.join(tmpBase, 'link');
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      const baseDir = path.join(linkPath, 'new-base');
      const nodeFs = new NodeFileSystem({ baseDir });

      await expect(nodeFs.writeAtomic('file.txt', 'data'))
        .rejects.toThrow(PathGuardError);
    } finally {
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* ignore */ });
      await fsp.rm(outsideDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
  });

  it('rejects write when baseDir ancestor symlink targets a sibling directory', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodefs-sibling-'));
    try {
      const outsideDir = path.join(tmpBase, 'outside');
      await fsp.mkdir(outsideDir, { recursive: true });

      const linkPath = path.join(tmpBase, 'link');
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      // baseDir sits under the symlink; its canonical root should be outsideDir/new-base,
      // so writing file.txt would land outside the intended container.
      const baseDir = path.join(linkPath, 'new-base');
      const nodeFs = new NodeFileSystem({ baseDir });

      await expect(nodeFs.writeAtomic('file.txt', 'data'))
        .rejects.toThrow(PathGuardError);
    } finally {
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
  });

  it('rejects write when baseDir exists and is a symlink to outside', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodefs-existing-outside-'));
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodefs-outside-existing-'));
    try {
      const linkPath = path.join(tmpBase, 'link');
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      // baseDir exists on disk via the symlink; realpathSync succeeds, so the
      // unconditional lstat check is required to detect the symlink traversal.
      const baseDir = path.join(linkPath, 'new-base');
      await fsp.mkdir(path.join(outsideDir, 'new-base'), { recursive: true });
      const nodeFs = new NodeFileSystem({ baseDir });

      await expect(nodeFs.writeAtomic('file.txt', 'data'))
        .rejects.toThrow(PathGuardError);
    } finally {
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* ignore */ });
      await fsp.rm(outsideDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
  });

  it('rejects write when baseDir exists via sibling symlink', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodefs-existing-sibling-'));
    try {
      const outsideDir = path.join(tmpBase, 'outside');
      await fsp.mkdir(outsideDir, { recursive: true });

      const linkPath = path.join(tmpBase, 'link');
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      // baseDir exists under the sibling symlink; realpathSync succeeds, so the
      // unconditional lstat check is required to detect the symlink traversal.
      const baseDir = path.join(linkPath, 'new-base');
      await fsp.mkdir(path.join(outsideDir, 'new-base'), { recursive: true });
      const nodeFs = new NodeFileSystem({ baseDir });

      await expect(nodeFs.writeAtomic('file.txt', 'data'))
        .rejects.toThrow(PathGuardError);
    } finally {
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
  });
});
