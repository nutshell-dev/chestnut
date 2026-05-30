/**
 * edit tool tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';

import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { readTool } from '../../../src/foundation/file-tool/read.js';
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

  it('should replace all matches with replaceAll=true (requires prior full read — phase 1447)', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'foo bar foo baz foo');

    // phase 1447: replaceAll=true requires fullread gate (same as write overwrite)
    await readTool.execute({ path: 'file.txt' }, ctx);

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

  // phase 1447: replaceAll fullread + stale gate (asymmetry fix vs write overwrite)
  describe('phase 1447: replaceAll fullread + stale gate', () => {
    it('rejects replaceAll when file has never been read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/r.txt', 'foo bar foo');

      const result = await editTool.execute({
        path: 'r.txt',
        oldText: 'foo',
        newText: 'qux',
        replaceAll: true,
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('not been fully read');
      expect(result.content).toContain('replaceAll=true rewrites every match');
      expect(result.content).toContain('set replaceAll=false');

      const content = await mockFs.read('clawspace/r.txt');
      expect(content).toBe('foo bar foo');
    });

    it('rejects replaceAll after partial read (limit smaller than totalLines)', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1} foo`).join('\n');
      await mockFs.writeAtomic('clawspace/p.txt', lines);

      // partial read: only 10 lines of 50
      await readTool.execute({ path: 'p.txt', limit: 10 }, ctx);

      const result = await editTool.execute({
        path: 'p.txt',
        oldText: 'foo',
        newText: 'qux',
        replaceAll: true,
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('not been fully read');
      expect(result.content).toContain('replaceAll=true rewrites every match');
    });

    it('allows replaceAll after full read', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/f.txt', 'foo bar foo');

      await readTool.execute({ path: 'f.txt' }, ctx);

      const result = await editTool.execute({
        path: 'f.txt',
        oldText: 'foo',
        newText: 'qux',
        replaceAll: true,
      }, ctx);

      expect(result.success).toBe(true);
      const content = await mockFs.read('clawspace/f.txt');
      expect(content).toBe('qux bar qux');
    });

    it('rejects replaceAll when file modified externally since last read (stale)', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/s.txt', 'foo bar foo');

      await readTool.execute({ path: 's.txt' }, ctx);

      // external modification: advance mtime + change content
      await new Promise(r => setTimeout(r, 15));
      const fsNative = await import('fs');
      fsNative.writeFileSync(path.join(tempDir, 'clawspace/s.txt'), 'foo CHANGED foo');

      const result = await editTool.execute({
        path: 's.txt',
        oldText: 'foo',
        newText: 'qux',
        replaceAll: true,
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toMatch(/modified since/);

      // file should be unchanged (rollback)
      const content = await mockFs.read('clawspace/s.txt');
      expect(content).toBe('foo CHANGED foo');
    });

    it('allows replaceAll=false (default) without read prerequisite', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/d.txt', 'unique-pattern content');

      // no read; unique-match edit should still work
      const result = await editTool.execute({
        path: 'd.txt',
        oldText: 'unique-pattern',
        newText: 'changed',
      }, ctx);

      expect(result.success).toBe(true);
    });
  });

  // phase 1456: error diagnostic + edge case polish
  describe('phase 1456: error diagnostics + edge cases', () => {
    it('0 match error includes near-miss hint when similar line exists', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/n.txt', 'header\nexport function foo(x: number)\nfooter');

      const result = await editTool.execute({
        path: 'n.txt',
        oldText: 'export function foo(x: number, y: string)',
        newText: 'whatever',
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('0 matches for oldText');
      expect(result.content).toContain('Near matches');
      expect(result.content).toContain('exact-prefix');
      expect(result.content).toContain('export function foo(x: number)');
    });

    it('multi match error includes line numbers list (first 5 + overflow indicator)', async () => {
      await mockFs.ensureDir('clawspace');
      const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1} target`).join('\n');
      await mockFs.writeAtomic('clawspace/m.txt', lines);

      const result = await editTool.execute({
        path: 'm.txt',
        oldText: 'target',
        newText: 'replaced',
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('8 matches');
      expect(result.content).toContain('at lines: 1, 2, 3, 4, 5, +3 more');
    });

    it('rejects no-op edit (oldText === newText) without touching file', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/nop.txt', 'unique content');
      const writeSpy = vi.spyOn(mockFs, 'writeAtomic');

      const result = await editTool.execute({
        path: 'nop.txt',
        oldText: 'unique',
        newText: 'unique',
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('no-op');
      // no fs write should happen
      const fileWrites = writeSpy.mock.calls.filter(([p]) => p === 'clawspace/nop.txt');
      expect(fileWrites.length).toBe(0);
      writeSpy.mockRestore();
    });

    it('rejects empty oldText immediately', async () => {
      await mockFs.ensureDir('clawspace');
      await mockFs.writeAtomic('clawspace/e.txt', 'content');

      const result = await editTool.execute({
        path: 'e.txt',
        oldText: '',
        newText: 'whatever',
      }, ctx);

      expect(result.success).toBe(false);
      expect(result.content).toContain('oldText must be a non-empty string');
    });
  });
});
