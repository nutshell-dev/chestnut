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
});
