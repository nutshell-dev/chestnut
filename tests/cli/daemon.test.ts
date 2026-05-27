import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsNative from 'fs';
import { randomUUID } from 'crypto';
import { TestProcessManager } from '../helpers/test-process-manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';

describe('ProcessManager.acquireLock — fix 004: TOCTOU race protection', () => {
  let tmpDir: string;
  let pm: TestProcessManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `daemon-fix4-${randomUUID()}`);
    fsNative.mkdirSync(tmpDir, { recursive: true });
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = new AuditWriter(fs, 'audit.tsv');
    pm = new TestProcessManager(fs, tmpDir, audit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fsNative.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup failure */ }
  });

  it('throws when another daemon acquires the lock during retry', () => {
    // 模拟 readLockPid 返回一个已死进程的 PID
    vi.spyOn(pm, 'readLockPid').mockReturnValue({ pid: 12345 });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    });
    // 模拟重试时又被抢占：deleteSync 成功，writeExclusiveSync 抛 EEXIST
    const fs = pm.testGetFs();
    const origWriteExclusive = fs.writeExclusiveSync.bind(fs);
    let callCount = 0;
    vi.spyOn(fs, 'writeExclusiveSync').mockImplementation((p: string, c: string) => {
      callCount++;
      if (callCount === 1 || callCount === 2) {
        const err: any = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      return origWriteExclusive(p, c);
    });

    expect(() => pm.acquireLock('test-claw')).toThrow(
      'Another "test-claw" daemon acquired the lock during retry',
    );
  });

  it('cleans stale lock with non-numeric content and acquires successfully', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), 'not-a-number');

    // 非数字 PID 被视为 stale lock，清理后成功获取
    pm.acquireLock('test-claw');
    const content = fsNative.readFileSync(path.join(statusDir, 'daemon.lock'), 'utf-8');
    expect(content).toBe(String(process.pid));
  });

  it('throws on EPERM (holder alive but no permission to signal)', () => {
    const fs = pm.testGetFs();
    vi.spyOn(fs, 'writeExclusiveSync').mockImplementation(() => {
      const err: any = new Error('EEXIST');
      err.code = 'EEXIST';
      throw err;
    });
    vi.spyOn(pm, 'readLockPid').mockReturnValue({ pid: 12345 });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    });

    // isAlive(pid) returns true for EPERM → LockConflictError (generic message)
    expect(() => pm.acquireLock('test-claw')).toThrow(
      'Another "test-claw" daemon is running (PID: 12345)',
    );
  });

  it('unknown kill errno → stale cleanup + retry (no longer conservative steal)', () => {
    const fs = pm.testGetFs();
    vi.spyOn(fs, 'writeExclusiveSync').mockImplementation(() => {
      const err: any = new Error('EEXIST');
      err.code = 'EEXIST';
      throw err;
    });
    vi.spyOn(pm, 'readLockPid').mockReturnValue({ pid: 12345 });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    });

    // isAlive(pid) returns false for unknown errno → stale cleanup → retry → EEXIST
    expect(() => pm.acquireLock('test-claw')).toThrow(
      'Another "test-claw" daemon acquired the lock during retry',
    );
  });

  it('releaseLock deletes lock when held by current process', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), String(process.pid));

    pm.releaseLock('test-claw');

    expect(fsNative.existsSync(path.join(statusDir, 'daemon.lock'))).toBe(false);
  });

  it('releaseLock is silent when lock file does not exist', () => {
    // 无锁文件，releaseLock 不应抛错
    expect(() => pm.releaseLock('test-claw')).not.toThrow();
  });

  it('releaseLock does nothing when lock is held by another process', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '99999');

    pm.releaseLock('test-claw');

    const content = fsNative.readFileSync(path.join(statusDir, 'daemon.lock'), 'utf-8');
    expect(content).toBe('99999');
  });

  it('writes lock_acquired audit on successful acquire', () => {
    pm.acquireLock('test-claw');
    const audit = fsNative.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(audit).toMatch(/lock_acquired/);
    expect(audit).toContain(`pid=${process.pid}`);
  });

  it('writes lock_released audit on successful release', () => {
    pm.acquireLock('test-claw');
    pm.releaseLock('test-claw');
    const audit = fsNative.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(audit).toMatch(/lock_released/);
  });
});
