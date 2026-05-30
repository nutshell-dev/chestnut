/**
 * multi_edit tool tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('multi_edit tool', () => {
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

  it('should apply edits sequentially and succeed', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'a b c d');

    const result = await multiEditTool.execute({
      path: 'file.txt',
      edits: [
        { oldText: 'a', newText: 'x' },
        { oldText: 'c', newText: 'y' },
      ],
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('2 edits applied');
    // phase 1434: applied summary + first-edit preview
    expect(result.content).toContain('Applied:');
    expect(result.content).toMatch(/edit\[0\]: at line \d+/);
    expect(result.content).toMatch(/edit\[1\]: at line \d+/);
    expect(result.content).toContain('First edit preview:');
    expect(result.content).toContain('@@ around line 1 @@');
    expect(result.content).toContain('- a');
    expect(result.content).toContain('+ x');
    expect(result.metadata).toEqual({ results: [{ index: 0, replaced: 1, line: 1 }, { index: 1, replaced: 1, line: 1 }] });

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('x b y d');
  });

  it('should abort and rollback on mid-way 0 match', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await multiEditTool.execute({
      path: 'file.txt',
      edits: [
        { oldText: 'hello', newText: 'hi' },
        { oldText: 'notfound', newText: 'replacement' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('edit[1]');
    expect(result.content).toContain('0 matches');
    expect(result.content).toContain('Verify current content with `read`');
    expect(result.content).toContain('an earlier edit may have invalidated this one');
    expect(result.metadata).toEqual({ failed_index: 1, results: [{ index: 0, replaced: 1, line: 1 }] });

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hello world');
  });

  it('should abort and rollback on mid-way multiple matches without replaceAll', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'foo bar foo');

    const result = await multiEditTool.execute({
      path: 'file.txt',
      edits: [
        { oldText: 'bar', newText: 'qux' },
        { oldText: 'foo', newText: 'qux' },
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
      path: 'file.txt',
      edits: [
        { oldText: 'hello', newText: 'goodbye' },
        { oldText: 'hello', newText: 'hi' },
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
      path: 'file.txt',
      edits: [
        { oldText: 'original', newText: 'updated' },
        { oldText: 'content', newText: 'data' },
      ],
    }, ctx);

    expect(result.success).toBe(true);

    const syncDir = path.join(tempDir, 'tasks', 'sync');
    const syncFiles = await fs.readdir(path.join(syncDir, 'write')).catch(() => []);
    expect(syncFiles.length).toBe(1);
    const backupContent = await fs.readFile(path.join(syncDir, 'write', syncFiles[0]), 'utf-8');
    expect(backupContent).toContain('source: multi_edit_backup');
    expect(backupContent).toContain('original content');
  });

  it('should write atomically once on success', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'a b c');
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic');

    await multiEditTool.execute({
      path: 'file.txt',
      edits: [
        { oldText: 'a', newText: 'x' },
        { oldText: 'b', newText: 'y' },
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
      path: 'file.txt',
      edits: [
        { oldText: 'a', newText: 'x' },
        { oldText: 'notfound', newText: 'y' },
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
      path: 'file.txt',
      edits: [],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('at least 1 edit');
  });

  // phase 1447: multi_edit with any replaceAll=true requires fullread + stale gate
  describe('phase 1447: multi_edit replaceAll fullread + stale gate', () => {
    it('rejects multi_edit when any edit has replaceAll=true and file not fully read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/r.txt', 'foo bar foo baz');

      const result = await multiEditTool.execute({
        path: 'r.txt',
        edits: [
          { oldText: 'bar', newText: 'BAR' },
          { oldText: 'foo', newText: 'qux', replaceAll: true },
        ],
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('not been fully read');
      expect(result.content).toContain('at least one edit uses replaceAll=true');
      expect(result.content).toContain('remove replaceAll from all edits');

      const content = await mockFs.read('clawspace/r.txt');
      expect(content).toBe('foo bar foo baz');
    });

    it('allows multi_edit with all unique-match edits (no replaceAll) without prior read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/u.txt', 'alpha beta gamma');

      const result = await multiEditTool.execute({
        path: 'u.txt',
        edits: [
          { oldText: 'alpha', newText: 'A' },
          { oldText: 'gamma', newText: 'G' },
        ],
      }, ctx);

      expect(result.success).toBe(true);
      const content = await mockFs.read('clawspace/u.txt');
      expect(content).toBe('A beta G');
    });

    it('allows multi_edit with replaceAll after full read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/f.txt', 'foo bar foo');

      await readTool.execute({ path: 'f.txt' }, ctx);

      const result = await multiEditTool.execute({
        path: 'f.txt',
        edits: [
          { oldText: 'foo', newText: 'qux', replaceAll: true },
        ],
      }, ctx);

      expect(result.success).toBe(true);
      const content = await mockFs.read('clawspace/f.txt');
      expect(content).toBe('qux bar qux');
    });

    it('rejects multi_edit replaceAll when file modified externally since read (stale)', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/s.txt', 'foo bar foo');

      await readTool.execute({ path: 's.txt' }, ctx);

      await new Promise(r => setTimeout(r, 15));
      const fsNative = await import('fs');
      fsNative.writeFileSync(path.join(tempDir, 'clawspace/s.txt'), 'foo CHANGED foo');

      const result = await multiEditTool.execute({
        path: 's.txt',
        edits: [
          { oldText: 'foo', newText: 'qux', replaceAll: true },
        ],
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toMatch(/modified since/);

      const content = await mockFs.read('clawspace/s.txt');
      expect(content).toBe('foo CHANGED foo');
    });
  });
});
