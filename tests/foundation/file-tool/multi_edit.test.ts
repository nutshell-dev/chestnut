/**
 * multi_edit tool tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { setPermissionCheckerFactory } from '../../../src/foundation/file-tool/permission-context.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('multi_edit tool', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
    });
    setPermissionCheckerFactory((clawDir) => createClawPermissionChecker({ clawDir, strict: true }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should apply edits sequentially and succeed', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'a b c d');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'a', new_string: 'x' },
        { old_string: 'c', new_string: 'y' },
      ],
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('2 edits applied');
    expect(result.metadata).toEqual({ results: [{ index: 0, replaced: 1 }, { index: 1, replaced: 1 }] });

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('x b y d');
  });

  it('should abort and rollback on mid-way 0 match', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'hello', new_string: 'hi' },
        { old_string: 'notfound', new_string: 'replacement' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('edit[1]');
    expect(result.content).toContain('0 matches');
    expect(result.metadata).toEqual({ failed_index: 1, results: [{ index: 0, replaced: 1 }] });

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hello world');
  });

  it('should abort and rollback on mid-way multiple matches without replace_all', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'foo bar foo');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'bar', new_string: 'qux' },
        { old_string: 'foo', new_string: 'qux' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('edit[1]');
    expect(result.content).toContain('2 matches');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('foo bar foo');
  });

  it('should handle edits that invalidate subsequent edits', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'hello', new_string: 'goodbye' },
        { old_string: 'hello', new_string: 'hi' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('edit[1]');
    expect(result.content).toContain('0 matches');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hello world');
  });

  it('should create a single backup file', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'original content');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'original', new_string: 'updated' },
        { old_string: 'content', new_string: 'data' },
      ],
    }, ctx);

    expect(result.success).toBe(true);

    const syncDir = path.join(tempDir, 'tasks', 'sync');
    const syncFiles = await fs.readdir(syncDir).catch(() => []);
    expect(syncFiles.length).toBe(1);
    const backupContent = await fs.readFile(path.join(syncDir, syncFiles[0]), 'utf-8');
    expect(backupContent).toContain('source: multi_edit_backup');
    expect(backupContent).toContain('original content');
  });

  it('should write atomically once on success', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'a b c');
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic');

    await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'a', new_string: 'x' },
        { old_string: 'b', new_string: 'y' },
      ],
    }, ctx);

    const fileWrites = writeSpy.mock.calls.filter(([p]) => p === 'clawspace/file.txt');
    expect(fileWrites.length).toBe(1);
    writeSpy.mockRestore();
  });

  it('should write zero times on failure', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'a b c');
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [
        { old_string: 'a', new_string: 'x' },
        { old_string: 'notfound', new_string: 'y' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    const fileWrites = writeSpy.mock.calls.filter(([p]) => p === 'clawspace/file.txt');
    expect(fileWrites.length).toBe(0);
    writeSpy.mockRestore();
  });

  it('should reject empty edits array', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello');

    const result = await multiEditTool.execute({
      path: 'clawspace/file.txt',
      edits: [],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('at least 1 edit');
  });
});
