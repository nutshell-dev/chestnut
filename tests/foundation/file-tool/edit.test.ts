/**
 * edit tool tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('edit tool', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });

  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should replace unique match', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'hello',
      newText: 'hi',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Edited:');
    expect(result.content).toContain('replaced 1/1');
    // phase 1434: diff preview shows context with - / + markers
    expect(result.content).toContain('@@ around line 1 @@');
    expect(result.content).toContain('- hello');
    expect(result.content).toContain('+ hi');
    expect(result.metadata).toEqual({ replaced: 1 });

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hi world');
  });

  it('should replace all matches with replaceAll=true', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'foo bar foo baz foo');

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'foo',
      newText: 'qux',
      replaceAll: true,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('replaced 3/3');
    expect(result.metadata).toEqual({ replaced: 3 });

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('qux bar qux baz qux');
  });

  it('should fail loud on 0 match', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'notfound',
      newText: 'replacement',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('0 matches');
    expect(result.content).toContain('Verify current content with `read`');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hello world');
  });

  it('should fail loud on multiple matches without replaceAll', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'foo bar foo');

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'foo',
      newText: 'qux',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('2 matches');
    expect(result.content).toContain('replaceAll=true');
    expect(result.content).toContain('Expand oldText with surrounding context');
    expect(result.content).toContain('Use `read` to confirm');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('foo bar foo');
  });

  it('should reject when file does not exist', async () => {
    const result = await editTool.execute({
      path: 'nonexistent.txt',
      oldText: 'a',
      newText: 'b',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('does not exist');
    expect(result.content).toContain('use write to create');
  });

  it('should backup to syncDir with frontmatter', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/versioned.txt', 'original content');

    const result = await editTool.execute({
      path: 'versioned.txt',
      oldText: 'original',
      newText: 'updated',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('backup:');

    const syncDir = path.join(tempDir, 'tasks', 'sync');
    const syncFiles = await fs.readdir(path.join(syncDir, 'write')).catch(() => []);
    expect(syncFiles.length).toBeGreaterThan(0);
    const backupFile = syncFiles[0];
    const backupContent = await fs.readFile(path.join(syncDir, 'write', backupFile), 'utf-8');
    expect(backupContent).toContain('source: edit_backup');
    expect(backupContent).toContain('original_path: clawspace/versioned.txt');
    expect(backupContent).toContain('original content');
  });

  it('should use atomic write', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/atomic.txt', 'hello');
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic');

    await editTool.execute({
      path: 'atomic.txt',
      oldText: 'hello',
      newText: 'world',
    }, ctx);

    expect(writeSpy).toHaveBeenCalledWith('clawspace/atomic.txt', 'world');
    writeSpy.mockRestore();
  });

  it('should succeed even if backup fails', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');
    const originalWriteAtomic = mockFs.writeAtomic.bind(mockFs);
    let callCount = 0;
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockImplementation(async (...args: [string, string]) => {
      callCount++;
      // First call is backup write — fail it
      if (callCount === 1) {
        throw new Error('disk full');
      }
      // Subsequent calls pass through
      return originalWriteAtomic(...args);
    });

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'hello',
      newText: 'hi',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).not.toContain('backup:');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hi world');
    writeSpy.mockRestore();
  });
});
