import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsNative from 'fs';
import { randomUUID } from 'crypto';
import { ProcessManager } from '../../src/foundation/process-manager/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';

describe('ProcessManager.acquireLock — fix 004: TOCTOU race protection', () => {
  let tmpDir: string;
  let pm: ProcessManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `daemon-fix4-${randomUUID()}`);
    fsNative.mkdirSync(tmpDir, { recursive: true });
    const fs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    const audit = new AuditWriter(fs, 'audit.tsv');
    pm = new ProcessManager(fs, tmpDir, audit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fsNative.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup failure */ }
  });

  it('throws when another daemon acquires the lock during retry', () => {
    // 模拟 readLockPid 返回一个已死进程的 PID
    vi.spyOn(pm as any, 'readLockPid').mockReturnValue(12345);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    });
    // 模拟重试时又被抢占：deleteSync 成功，writeExclusiveSync 抛 EEXIST
    const fs = (pm as any).fs;
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
});
