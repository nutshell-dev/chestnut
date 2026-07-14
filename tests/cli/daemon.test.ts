import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testClawDaemonDir, testMotionDaemonDir } from '../helpers/daemon-dir.js';
import * as path from 'path';
import * as fsNative from 'fs';
import { createTrackedTempDirSync, cleanupTempDirSync } from '../utils/temp.js';
import { TestProcessManager } from '../helpers/test-process-manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';

describe('ProcessManager.acquireLock — fix 004: TOCTOU race protection', () => {
  let tmpDir: string;
  let pm: TestProcessManager;

  beforeEach(() => {
    tmpDir = createTrackedTempDirSync('daemon-fix4-');
    fsNative.mkdirSync(tmpDir, { recursive: true });
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = new AuditWriter(fs, 'audit.tsv');
    pm = new TestProcessManager(fs, audit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDirSync(tmpDir);
  });

  it('throws when another daemon acquires the lock during retry', () => {
    // Pre-create a lockfile holding a dead PID
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '12345');

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

    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /acquired the lock during retry/,
    );
  });

  it('throws when lock file has corrupt non-numeric content', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), 'not-a-number');

    // corrupt lock → fail closed
    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /Cannot acquire lock: corrupt/,
    );
  });

  it('throws on EPERM (holder alive but no permission to signal)', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '12345');

    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    });

    // isAlive(pid) returns true for EPERM → LockConflictError
    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /daemon is running \(PID: 12345\)/,
    );
  });

  it('unknown kill errno → stale cleanup + retry (no longer conservative steal)', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '12345');

    const fs = pm.testGetFs();
    vi.spyOn(fs, 'writeExclusiveSync').mockImplementation(() => {
      const err: any = new Error('EEXIST');
      err.code = 'EEXIST';
      throw err;
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    });

    // isAlive(pid) returns false for unknown errno → stale cleanup → retry → EEXIST
    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /acquired the lock during retry/,
    );
  });

  it('releaseLock deletes lock when held by current process', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), String(process.pid));

    pm.releaseLock(testClawDaemonDir(tmpDir, 'test-claw'));

    expect(fsNative.existsSync(path.join(statusDir, 'daemon.lock'))).toBe(false);
  });

  it('releaseLock is silent when lock file does not exist', () => {
    // 无锁文件，releaseLock 不应抛错
    expect(() => pm.releaseLock(testClawDaemonDir(tmpDir, 'test-claw'))).not.toThrow();
  });

  it('releaseLock does nothing when lock is held by another process', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '99999');

    pm.releaseLock(testClawDaemonDir(tmpDir, 'test-claw'));

    const content = fsNative.readFileSync(path.join(statusDir, 'daemon.lock'), 'utf-8');
    expect(content).toBe('99999');
  });

  it('writes lock_acquired audit on successful acquire', () => {
    pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'));
    const audit = fsNative.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(audit).toMatch(/lock_acquired/);
    expect(audit).toContain(`pid=${process.pid}`);
  });

  it('writes lock_released audit on successful release', () => {
    pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'));
    pm.releaseLock(testClawDaemonDir(tmpDir, 'test-claw'));
    const audit = fsNative.readFileSync(path.join(tmpDir, 'audit.tsv'), 'utf-8');
    expect(audit).toMatch(/lock_released/);
  });
});
