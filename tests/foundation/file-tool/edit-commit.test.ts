/**
 * phase 1109 Step C: edit-commit coordinator tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

import { editCommit } from '../../../src/foundation/file-tool/edit-commit.js';
import { backupToSync } from '../../../src/foundation/file-tool/sync-backup.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

function createAuditWriter() {
  return {
    __brand: 'AuditLog' as const,
    write: vi.fn(),
    preview: vi.fn(),
    message: vi.fn(),
    summary: vi.fn(),
  };
}

describe('edit-commit coordinator', () => {
  let tempDir: string;
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;

  beforeEach(async () => {
    tempDir = await createTempDir();
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: mockFs }),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('commits a simple edit and returns hash metadata', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const result = await editCommit({
      ctx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await ctx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.beforeHash).toHaveLength(64);
    expect(result.afterHash).toHaveLength(64);
    expect(result.afterHash).not.toBe(result.beforeHash);
    expect(result.backupPath).toContain('tasks/sync/write/');
    expect(result.mtime).toBeGreaterThan(0);

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hi world');
  });

  it('detects content-hash conflict and writes nothing', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    // Coordinator reads current after the tool already read original; simulate external edit.
    let readCount = 0;
    const racedFs: FileSystem = new Proxy(mockFs, {
      get(target, prop, receiver) {
        if (prop === 'read') {
          return async (p: string): Promise<string> => {
            readCount++;
            if (readCount === 1 && p === 'clawspace/file.txt') {
              return 'hello CHANGED world';
            }
            return target.read(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as FileSystem;

    const auditWriter = createAuditWriter();
    const racedCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: racedFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: mockFs }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: racedCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await racedCtx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hello world');

    expect(auditWriter.write).toHaveBeenCalled();
    const conflictCall = auditWriter.write.mock.calls.find((call: string[]) =>
      call[0] === 'file_edit_conflict'
    );
    expect(conflictCall).toBeDefined();
    expect(conflictCall!.slice(1).join(' ')).toContain('stage=precommit');
  });

  it('fails closed when backup fails and does not write target', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.ensureDir('tasks/sync/write');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const originalWriteAtomic = mockFs.writeAtomic.bind(mockFs);
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockImplementation(async (...args: [string, string]) => {
      const [targetPath] = args;
      if (targetPath.includes('/sync/write/') || targetPath.includes('tasks\\sync\\write\\')) {
        throw new Error('disk full');
      }
      return originalWriteAtomic(...args);
    });

    const auditWriter = createAuditWriter();
    const testCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: mockFs }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await testCtx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('backup-failed');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hello world');

    const targetWrites = writeSpy.mock.calls.filter(([p]) => p === 'clawspace/file.txt');
    expect(targetWrites.length).toBe(0);

    const backupFailedCall = auditWriter.write.mock.calls.find((call: string[]) =>
      call[0] === 'file_edit_backup_failed'
    );
    expect(backupFailedCall).toBeDefined();

    writeSpy.mockRestore();
  });

  it('detects post-write verification failure and keeps backup', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    let readCount = 0;
    const racedFs: FileSystem = new Proxy(mockFs, {
      get(target, prop, receiver) {
        if (prop === 'read') {
          return async (p: string): Promise<string> => {
            readCount++;
            // 1: pre-commit current, 2: backup content, 3: post-write verification
            if (readCount === 3 && p === 'clawspace/file.txt') {
              return 'verification tampered';
            }
            return target.read(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as FileSystem;

    const auditWriter = createAuditWriter();
    const testCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: racedFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: mockFs }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await testCtx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('verification-failed');

    // Backup should still exist; target may have been overwritten by the failed verification path.
    const backupFiles = await mockFs.list('tasks/sync/write');
    expect(backupFiles.length).toBeGreaterThan(0);

    const verifyFailedCall = auditWriter.write.mock.calls.find((call: string[]) =>
      call[0] === 'file_edit_verification_failed'
    );
    expect(verifyFailedCall).toBeDefined();
    expect(verifyFailedCall!.slice(1).join(' ')).toContain('expected_hash=');
    expect(verifyFailedCall!.slice(1).join(' ')).toContain('actual_hash=');
  });

  it('sequential second commit with stale original returns conflict and 0 target write', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const first = await editCommit({
      ctx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await ctx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });
    expect(first.ok).toBe(true);

    const auditWriter = createAuditWriter();
    const testCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: mockFs }),
      auditWriter,
    });

    // Second commit still carries the original content from before the first edit;
    // precommit hash check must detect the drift and write nothing.
    const second = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await testCtx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hey world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('conflict');

    const content = await mockFs.read('clawspace/file.txt');
    expect(content).toBe('hi world');

    const conflictCall = auditWriter.write.mock.calls.find((call: string[]) =>
      call[0] === 'file_edit_conflict'
    );
    expect(conflictCall).toBeDefined();
    expect(conflictCall!.slice(1).join(' ')).toContain('stage=precommit');
  });

  it('emits committed audit with hash metadata', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const auditWriter = createAuditWriter();
    const testCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: mockFs }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await testCtx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(true);

    const committedCall = auditWriter.write.mock.calls.find((call: string[]) =>
      call[0] === 'file_edit_committed'
    );
    expect(committedCall).toBeDefined();
    const payload = committedCall!.slice(1).join(' ');
    expect(payload).toContain('tool=edit');
    expect(payload).toContain('path=file.txt');
    expect(payload).toContain('before_hash=');
    expect(payload).toContain('after_hash=');
    expect(payload).toContain('backup_path=');
    expect(payload).toContain('replaced=1');
    expect(payload).toContain('edit_count=1');
  });
});

/* ========================================================================
 * phase 2093 Step B：backup 判别联合消费回归
 *  - helper 三态（created / absent / failed）直接断言
 *  - editCommit 只接受 created：absent（备份前消失）与 failed 均沿原
 *    backup-failed 结果返回，且 0 目标写入
 * ===================================================================== */
describe('phase 2093 Step B: backup result union consumption', () => {
  let tempDir: string;
  let syncFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    syncFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(fsImpl: NodeFileSystem, auditWriter = createAuditWriter()): ExecContextImpl {
    return new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      workspaceDir: path.join(tempDir, 'clawspace'),
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: fsImpl,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir: tempDir, strict: true, fs: syncFs }),
      auditWriter,
    });
  }

  it('helper 返回 absent：目标确定不存在时不产生备份文件', async () => {
    await syncFs.ensureDir('clawspace');
    const ctx = makeCtx(syncFs);

    const result = await backupToSync(ctx, 'clawspace/missing.txt', 'file_backup');

    expect(result.kind).toBe('absent');
    expect(await syncFs.list('tasks/sync/write').catch(() => [])).toEqual([]);
  });

  it('helper 返回 created：备份含旧全文，path 相对 clawDir', async () => {
    await syncFs.ensureDir('clawspace');
    await syncFs.writeAtomic('clawspace/file.txt', 'hello world');
    const ctx = makeCtx(syncFs);

    const result = await backupToSync(ctx, 'clawspace/file.txt', 'edit_backup');

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.path).toContain('tasks/sync/write/');
    const backup = await syncFs.read(result.path);
    expect(backup).toContain('source: edit_backup');
    expect(backup).toContain('hello world');
  });

  it('helper 返回 failed 且 error 可读：备份写失败不吞成 absent', async () => {
    await syncFs.ensureDir('clawspace');
    await syncFs.writeAtomic('clawspace/file.txt', 'hello world');
    const failingFs = new Proxy(syncFs, {
      get(target, prop, receiver) {
        if (prop === 'writeAtomic') {
          return async (p: string, content: string) => {
            if (p.includes('tasks/sync/write/')) throw new Error('[EIO] synthetic backup EIO');
            return target.writeAtomic(p, content);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as NodeFileSystem;
    const auditWriter = createAuditWriter();
    const ctx = makeCtx(failingFs, auditWriter);

    const result = await backupToSync(ctx, 'clawspace/file.txt', 'file_backup');

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.error).toContain('EIO');
    const failedCall = auditWriter.write.mock.calls.find((call: string[]) => call[0] === 'file_tool_backup_failed');
    expect(failedCall).toBeDefined();
  });

  it('editCommit 消费 absent：备份前目标消失 → backup-failed 且 0 目标写入，文件仍缺失', async () => {
    await syncFs.ensureDir('clawspace');
    await syncFs.writeAtomic('clawspace/file.txt', 'hello world');

    let existsCalls = 0;
    const vanishingFs = new Proxy(syncFs, {
      get(target, prop, receiver) {
        if (prop === 'exists') {
          return async (p: string) => {
            existsCalls++;
            if (p === 'clawspace/file.txt' && existsCalls === 1) {
              // 冲突检测已读成功后，备份前目标消失
              await target.delete('clawspace/file.txt');
              return false;
            }
            return target.exists(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as NodeFileSystem;

    const auditWriter = createAuditWriter();
    const ctx = makeCtx(vanishingFs, auditWriter);

    const guardedWrite = await ctx.permissionChecker!.prepareWrite('clawspace/file.txt');
    let targetWrites = 0;
    const countingGuarded = {
      target: guardedWrite.target,
      write: async (content: string) => {
        targetWrites++;
        return guardedWrite.write(content);
      },
      append: guardedWrite.append.bind(guardedWrite),
    };

    const result = await editCommit({
      ctx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: countingGuarded,
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('backup-failed');
    expect(targetWrites).toBe(0);
    await expect(syncFs.stat('clawspace/file.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
    const backupFailedCall = auditWriter.write.mock.calls.find((call: string[]) => call[0] === 'file_edit_backup_failed');
    expect(backupFailedCall).toBeDefined();
  });

  it('editCommit 消费 failed：备份写失败 → backup-failed，原文件保持（与既有用例互补）', async () => {
    await syncFs.ensureDir('clawspace');
    await syncFs.ensureDir('tasks/sync/write');
    await syncFs.writeAtomic('clawspace/file.txt', 'hello world');

    let backupWriteAttempts = 0;
    const failingFs = new Proxy(syncFs, {
      get(target, prop, receiver) {
        if (prop === 'writeAtomic') {
          return async (p: string, content: string) => {
            if (p.includes('tasks/sync/write/')) {
              backupWriteAttempts++;
              throw new Error('[ENOSPC] synthetic backup ENOSPC');
            }
            return target.writeAtomic(p, content);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as NodeFileSystem;

    const auditWriter = createAuditWriter();
    const ctx = makeCtx(failingFs, auditWriter);

    const result = await editCommit({
      ctx,
      tool: 'multi_edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      guardedWrite: await ctx.permissionChecker!.prepareWrite('clawspace/file.txt'),
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'multi_edit_backup',
      replaced: 1,
      editCount: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('backup-failed');
    expect(backupWriteAttempts).toBe(1);
    expect(await syncFs.read('clawspace/file.txt')).toBe('hello world');
    expect(auditWriter.write.mock.calls.some((call: string[]) => call[0] === 'file_edit_backup_failed')).toBe(true);
  });
});
