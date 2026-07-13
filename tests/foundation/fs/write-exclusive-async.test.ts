/**
 * Phase 446 (review N3-H1): NodeFileSystem.writeExclusive async O_EXCL contract.
 *
 * Verifies the async variant mirrors writeExclusiveSync:
 * - 创建新文件
 * - 既存文件抛 EEXIST、保留原内容
 * - 父目录自动 mkdir recursive
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('NodeFileSystem.writeExclusive (phase 446)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `fs-wx-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('creates new file with content', async () => {
    await nfs.writeExclusive('a.txt', 'hello');
    const got = await fs.readFile(path.join(testDir, 'a.txt'), 'utf-8');
    expect(got).toBe('hello');
  });

  it('throws EEXIST when file already exists, preserves existing content', async () => {
    await fs.writeFile(path.join(testDir, 'b.txt'), 'existing');
    await expect(nfs.writeExclusive('b.txt', 'new')).rejects.toMatchObject({ code: 'EEXIST' });
    // existing content preserved
    const got = await fs.readFile(path.join(testDir, 'b.txt'), 'utf-8');
    expect(got).toBe('existing');
  });

  it('creates parent directory recursively', async () => {
    await nfs.writeExclusive('nested/deep/c.txt', 'deep');
    const got = await fs.readFile(path.join(testDir, 'nested', 'deep', 'c.txt'), 'utf-8');
    expect(got).toBe('deep');
  });

  it('writes empty content (no body)', async () => {
    await nfs.writeExclusive('empty.txt', '');
    const stat = await fs.stat(path.join(testDir, 'empty.txt'));
    expect(stat.size).toBe(0);
  });
});
