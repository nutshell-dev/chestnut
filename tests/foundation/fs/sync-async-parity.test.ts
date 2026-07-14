import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('fs/types.ts: sync/async parity', () => {
  it('interface contains removeDirSync, realpathSync, isDirectorySync', () => {
    const src = fs.readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).toMatch(/removeDirSync\(/);
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
