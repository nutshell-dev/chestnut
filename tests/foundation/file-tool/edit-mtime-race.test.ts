/**
 * phase 517 B4 regression:
 * edit must detect mtime change between read and write (external modification race).
 * Without check: read content + replace + writeAtomic 覆盖外部已写内容 silent。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem, StatInfo } from '../../../src/foundation/fs/types.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('edit mtime race detection (phase 517 B4)', () => {
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

  it('refuses to write when mtime changes between read and write', async () => {
    await realFs.ensureDir('clawspace');
    await realFs.writeAtomic('clawspace/file.txt', 'hello world');

    // wrap fs to simulate external mtime change between read (T1) and write (T2)
    let statCallCount = 0;
    const initialMtime = (await realFs.stat('clawspace/file.txt')).mtime;
    const racedFs: FileSystem = new Proxy(realFs, {
      get(target, prop, receiver) {
        if (prop === 'stat') {
          return async (p: string): Promise<StatInfo> => {
            const real = await target.stat(p);
            statCallCount++;
            // 1st stat (T1 — before read): return real
            // 2nd stat (T2 — before write, the guard): bump mtime to simulate external write
            if (statCallCount === 2) {
              return { ...real, mtime: new Date(initialMtime.getTime() + 1000) };
            }
            return real;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

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

    // confirm file was NOT touched (content still 'hello world')
    const after = await realFs.read('clawspace/file.txt');
    expect(after).toBe('hello world');
  });

  it('proceeds normally when mtime is stable', async () => {
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
});
