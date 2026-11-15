import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FileNotFoundError, PathGuardError } from '../../../src/foundation/fs/types.js';

describe('fs/types.ts: sync/async parity', () => {
  it('interface contains removeDirSync, moveDirSync, realpathSync, isDirectorySync', () => {
    const src = fs.readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).toMatch(/removeDirSync\(/);
    expect(src).toMatch(/moveDirSync\(/);
    expect(src).toMatch(/realpathSync\(/);
    expect(src).toMatch(/isDirectorySync\(/);
  });

  it('NodeFileSystem implements removeDirSync correctly', async () => {
    const tmpDir = fs.realpathSync(await createTrackedTempDir('fs-parity-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'file.txt'), 'hello');

    nodeFs.removeDirSync('subdir');
    expect(fs.existsSync(path.join(tmpDir, 'subdir'))).toBe(false);

    await cleanupTempDir(tmpDir);
  });

  it('removeDir async/sync report the same typed missing error', async () => {
    const tmpDir = fs.realpathSync(await createTrackedTempDir('fs-parity-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    const asyncError = await nodeFs.removeDir('missing-dir').then(
      () => undefined,
      (error: unknown) => error,
    );
    let syncError: unknown;
    try {
      nodeFs.removeDirSync('missing-dir');
    } catch (error) {
      syncError = error;
    }

    expect(asyncError).toBeInstanceOf(FileNotFoundError);
    expect(syncError).toBeInstanceOf(FileNotFoundError);
    expect(asyncError).toMatchObject({
      code: 'FS_NOT_FOUND',
      context: { path: 'missing-dir' },
    });
    expect(syncError).toMatchObject({
      code: 'FS_NOT_FOUND',
      context: { path: 'missing-dir' },
    });

    await cleanupTempDir(tmpDir);
  });

  it('removeDir async/sync preserve non-ENOENT failures', async () => {
    const tmpDir = fs.realpathSync(await createTrackedTempDir('fs-parity-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'not-a-directory'), 'file');

    const asyncError = await nodeFs.removeDir('not-a-directory/child').then(
      () => undefined,
      (error: unknown) => error,
    );
    let syncError: unknown;
    try {
      nodeFs.removeDirSync('not-a-directory/child');
    } catch (error) {
      syncError = error;
    }

    expect(asyncError).not.toBeInstanceOf(FileNotFoundError);
    expect(syncError).not.toBeInstanceOf(FileNotFoundError);
    expect(asyncError).toMatchObject({ code: 'ENOTDIR' });
    expect(syncError).toMatchObject({ code: 'ENOTDIR' });

    await cleanupTempDir(tmpDir);
  });

  it('removeDir async/sync apply the path guard before I/O', async () => {
    const tmpDir = fs.realpathSync(await createTrackedTempDir('fs-parity-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    await expect(nodeFs.removeDir('../outside')).rejects.toBeInstanceOf(PathGuardError);
    expect(() => nodeFs.removeDirSync('../outside')).toThrow(PathGuardError);

    await cleanupTempDir(tmpDir);
  });

  it('NodeFileSystem implements realpathSync correctly', async () => {
    const tmpDir = fs.realpathSync(await createTrackedTempDir('fs-parity-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    fs.symlinkSync(path.join(tmpDir, 'file.txt'), path.join(tmpDir, 'link.txt'));

    const resolved = nodeFs.realpathSync('link.txt');
    expect(resolved).toBe(path.join(tmpDir, 'file.txt'));

    await cleanupTempDir(tmpDir);
  });

  it('NodeFileSystem implements isDirectorySync correctly', async () => {
    const tmpDir = fs.realpathSync(await createTrackedTempDir('fs-parity-test-'));
    const nodeFs = new NodeFileSystem({ baseDir: tmpDir });

    fs.mkdirSync(path.join(tmpDir, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');

    expect(nodeFs.isDirectorySync('dir')).toBe(true);
    expect(nodeFs.isDirectorySync('file.txt')).toBe(false);
    expect(nodeFs.isDirectorySync('missing')).toBe(false);

    await cleanupTempDir(tmpDir);
  });
});
