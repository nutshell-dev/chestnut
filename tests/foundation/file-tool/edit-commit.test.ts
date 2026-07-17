/**
 * phase 1109 Step C: edit-commit coordinator tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

import { editCommit } from '../../../src/foundation/file-tool/edit-commit.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
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
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
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
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: racedFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: racedCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
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
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
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
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: racedFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
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

  it('serializes concurrent same-path commits so at most one succeeds', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    let releaseFirstWrite: () => void;
    const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
    let targetWriteCount = 0;
    const originalWriteAtomic = mockFs.writeAtomic.bind(mockFs);
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockImplementation(async (...args: [string, string]) => {
      const [targetPath] = args;
      if (targetPath === 'clawspace/file.txt') {
        targetWriteCount++;
        if (targetWriteCount === 1) {
          await firstWriteGate;
        }
      }
      return originalWriteAtomic(...args);
    });

    const commit1 = editCommit({
      ctx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      original: 'hello world',
      candidate: 'hi world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    const commit2 = editCommit({
      ctx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
      original: 'hello world',
      candidate: 'hey world',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    // Let both tasks reach the coordinator queue.
    await new Promise(r => setTimeout(r, 10));
    releaseFirstWrite!();

    const [result1, result2] = await Promise.all([commit1, commit2]);

    const successes = [result1, result2].filter(r => r.ok).length;
    expect(successes).toBe(1);

    const content = await mockFs.read('clawspace/file.txt');
    expect(['hi world', 'hey world']).toContain(content);

    writeSpy.mockRestore();
  });

  it('does not serialize commits on different paths', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/a.txt', 'a');
    await mockFs.writeAtomic('clawspace/b.txt', 'b');

    let releaseA: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    let aWriteCount = 0;
    const originalWriteAtomic = mockFs.writeAtomic.bind(mockFs);
    const writeSpy = vi.spyOn(mockFs, 'writeAtomic').mockImplementation(async (...args: [string, string]) => {
      const [targetPath] = args;
      if (targetPath === 'clawspace/a.txt') {
        aWriteCount++;
        if (aWriteCount === 1) {
          await gateA;
        }
      }
      return originalWriteAtomic(...args);
    });

    const commitA = editCommit({
      ctx,
      tool: 'edit',
      path: 'a.txt',
      resolved: 'clawspace/a.txt',
      original: 'a',
      candidate: 'A',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    const commitB = editCommit({
      ctx,
      tool: 'edit',
      path: 'b.txt',
      resolved: 'clawspace/b.txt',
      original: 'b',
      candidate: 'B',
      backupSource: 'edit_backup',
      replaced: 1,
      editCount: 1,
    });

    // B must complete even though A is still blocked on its first target write.
    const bCompleted = await Promise.race([
      commitB.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    expect(bCompleted).toBe(true);

    releaseA!();
    await Promise.all([commitA, commitB]);

    expect(await mockFs.read('clawspace/a.txt')).toBe('A');
    expect(await mockFs.read('clawspace/b.txt')).toBe('B');

    writeSpy.mockRestore();
  });

  it('emits committed audit with hash metadata', async () => {
    await mockFs.ensureDir('clawspace');
    await mockFs.writeAtomic('clawspace/file.txt', 'hello world');

    const auditWriter = createAuditWriter();
    const testCtx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'subagent',
      fs: mockFs,
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      auditWriter,
    });

    const result = await editCommit({
      ctx: testCtx,
      tool: 'edit',
      path: 'file.txt',
      resolved: 'clawspace/file.txt',
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
