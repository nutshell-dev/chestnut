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

  it('throws when another daemon holds the per-contender lock', () => {
    // Pre-create a legacy lockfile holding a dead PID; migrate deletes it.
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '12345');

    vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 12345) {
        const err: any = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      // 其他 pid（含 99999 与 process.pid）视为存活
    });

    // 模拟另一个存活 contender 已持有 per-contender claim → 本进程选举失败。
    const claimsDir = path.join(statusDir, 'daemon.lock-lock', 'claims');
    fsNative.mkdirSync(claimsDir, { recursive: true });
    const earlierToken = 'other-token';
    fsNative.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.99999.${earlierToken}`),
      JSON.stringify({ pid: 99999, timestamp: Date.now() - 1000, ownerToken: earlierToken, startTime: '0' }),
      { flag: 'wx' },
    );

    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /Election lost/,
    );
  });

  it('throws when lock file has corrupt non-numeric content', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), 'not-a-number');

    // corrupt legacy lock → fail closed
    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /Cannot migrate legacy lock: corrupt/,
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

  it('unknown kill errno → stale cleanup + election lost (no longer conservative steal)', () => {
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), '12345');

    vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 12345) {
        const err: any = new Error('EINVAL');
        err.code = 'EINVAL';
        throw err;
      }
      // 其他 pid（含 99999 与 process.pid）视为存活
    });

    // 未知 errno → 旧持有者视为已死 → migrate 删除 legacy lock；
    // 同时另一个存活 contender 已持有 claim → 选举失败。
    const claimsDir = path.join(statusDir, 'daemon.lock-lock', 'claims');
    fsNative.mkdirSync(claimsDir, { recursive: true });
    const earlierToken = 'other-token';
    fsNative.writeFileSync(
      path.join(claimsDir, `claim.${Date.now() - 1000}.99999.${earlierToken}`),
      JSON.stringify({ pid: 99999, timestamp: Date.now() - 1000, ownerToken: earlierToken, startTime: '0' }),
      { flag: 'wx' },
    );

    expect(() => pm.acquireLock(testClawDaemonDir(tmpDir, 'test-claw'))).toThrow(
      /Election lost/,
    );
  });

  it('releaseLock does not delete legacy lock without owner token', () => {
    // Phase 1056: legacy release 不再提供无 token 删除路径；旧格式锁应通过
    // migrate/stale recovery 清理，或由旧持有者按旧协议释放。
    const statusDir = path.join(tmpDir, 'claws', 'test-claw', 'status');
    fsNative.mkdirSync(statusDir, { recursive: true });
    fsNative.writeFileSync(path.join(statusDir, 'daemon.lock'), String(process.pid));

    pm.releaseLock(testClawDaemonDir(tmpDir, 'test-claw'));

    expect(fsNative.existsSync(path.join(statusDir, 'daemon.lock'))).toBe(true);
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
