/**
 * phase 1109 Step C regression:
 * edit / multi_edit detect content-hash conflict between read and write.
 *
 * Replaces phase 517 B4 mtime-only race detection with content-hash verification
 * inside the shared editCommit coordinator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('edit content-hash conflict detection (phase 1109 Step C)', () => {
  let tempDir: string;
  let realFs: NodeFileSystem;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    realFs = new NodeFileSystem({ baseDir: tempDir });
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: realFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function buildRacedFs(initialContent: string, racedContent: string): FileSystem {
    let readCount = 0;
    return new Proxy(realFs, {
      get(target, prop, receiver) {
        if (prop === 'read') {
          return async (p: string): Promise<string> => {
            readCount++;
            // 1st read: tool reads original
            // 2nd read: coordinator re-reads current (simulate external modification)
            if (readCount === 2) {
              return racedContent;
            }
            return target.read(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as FileSystem;
  }

  it('edit refuses to write when content changes between read and write (same mtime)', async () => {
    await realFs.ensureDir('clawspace');
    await realFs.writeAtomic('clawspace/file.txt', 'hello world');

    const racedFs = buildRacedFs('hello world', 'hello CHANGED world');
    const racedCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: racedFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'hello',
      newText: 'hi',
    }, racedCtx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('modified externally');
    expect(result.content).toContain('Re-read');

    const after = await realFs.read('clawspace/file.txt');
    expect(after).toBe('hello world');
  });

  it('edit proceeds normally when content is stable', async () => {
    await realFs.ensureDir('clawspace');
    await realFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await editTool.execute({
      path: 'file.txt',
      oldText: 'hello',
      newText: 'hi',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Edited:');
    const after = await realFs.read('clawspace/file.txt');
    expect(after).toBe('hi world');
  });

  it('multi_edit refuses to write when content changes between read and write', async () => {
    await realFs.ensureDir('clawspace');
    await realFs.writeAtomic('clawspace/file.txt', 'alpha beta gamma');

    const racedFs = buildRacedFs('alpha beta gamma', 'alpha CHANGED gamma');
    const racedCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: racedFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });

    const result = await multiEditTool.execute({
      path: 'file.txt',
      edits: [
        { oldText: 'alpha', newText: 'A' },
        { oldText: 'gamma', newText: 'G' },
      ],
    }, racedCtx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('modified externally');
    expect(result.content).toContain('Re-read');

    const after = await realFs.read('clawspace/file.txt');
    expect(after).toBe('alpha beta gamma');
  });

  it('multi_edit proceeds normally when content is stable', async () => {
    await realFs.ensureDir('clawspace');
    await realFs.writeAtomic('clawspace/file.txt', 'alpha beta gamma');

    const result = await multiEditTool.execute({
      path: 'file.txt',
      edits: [
        { oldText: 'alpha', newText: 'A' },
        { oldText: 'gamma', newText: 'G' },
      ],
    }, ctx);

    expect(result.success).toBe(true);
    const after = await realFs.read('clawspace/file.txt');
    expect(after).toBe('A beta G');
  });
});
