/**
 * Contract Lock 子模块测试
 *
 * Phase 576: lock JSON.parse defensive schema 校验
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, releaseLock, lockContract } from '../../../src/core/contract/lock.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { DEAD_PID } from '../../helpers/dead-pid.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { makeContractId } from '../../../src/core/contract/types.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

let tmpDir: string;
let nodeFs: NodeFileSystem;
let mockAudit: { write: ReturnType<typeof vi.fn> };

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-lock-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  mockAudit = makeMockAudit();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

describe('acquireLock', () => {
  it('lock 文件 schema 非法（pid 非 number）→ audit LOCK_SCHEMA_INVALID + 走 corrupt 路径重建（A.lock-schema-validation phase 576）', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // 预先写入 schema 非法的 lock 文件
    await fs.writeFile(absLockPath, JSON.stringify({ pid: 'abc', time: null }), 'utf-8');

    await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    // audit LOCK_SCHEMA_INVALID 被调用
    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_lock_schema_invalid',
      expect.stringMatching(/^path=/),
      expect.stringMatching(/^raw=/),
    );

    // 第二次 retry 成功写入，锁文件内容应为合法 schema
    const raw = await fs.readFile(absLockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(typeof parsed.pid).toBe('number');
    expect(typeof parsed.time).toBe('number');
  }, 2000);

  it('lock 文件 schema 合法（pid + time 皆 number）但 pid dead → 0 LOCK_SCHEMA_INVALID audit / 走 stale_pid 路径', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // 写入合法但 dead pid 的 lock 文件
    await fs.writeFile(absLockPath, JSON.stringify({ pid: DEAD_PID, time: Date.now(), ownerToken: 'existing-token' }), 'utf-8');

    await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    const schemaInvalidCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === 'contract_lock_schema_invalid'
    );
    expect(schemaInvalidCalls).toHaveLength(0);

    // 第二次 retry 成功写入
    const raw = await fs.readFile(absLockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);
  }, 2000);

  it('lock 文件 schema 合法且 alive → 0 LOCK_SCHEMA_INVALID audit + acquireLock 最终失败', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // 写入当前进程持有的合法 lock 文件
    await fs.writeFile(absLockPath, JSON.stringify({ pid: process.pid, time: Date.now(), ownerToken: 'existing-token' }), 'utf-8');

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath)
    ).rejects.toThrow(/Failed to acquire lock after/);

    const schemaInvalidCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === 'contract_lock_schema_invalid'
    );
    expect(schemaInvalidCalls).toHaveLength(0);
  }, 2000);

  it('lock 文件 schema 非法（time 为 NaN）→ audit LOCK_SCHEMA_INVALID', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    await fs.writeFile(absLockPath, JSON.stringify({ pid: FAKE_LIVE_PID, time: NaN }), 'utf-8');

    // Treat the legacy PID as dead so the schema-invalid path can isolate/unlink it.
    await acquireLock({ fs: nodeFs, audit: mockAudit as any, l1IsAlive: () => false }, lockPath);

    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_lock_schema_invalid',
      expect.stringMatching(/^path=/),
      expect.stringMatching(/^raw=/),
    );
  }, 2000);

  it('throws without deleting lock when l1IsAlive fails', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // Write a lock held by a fake live PID.
    await fs.writeFile(absLockPath, JSON.stringify({ pid: FAKE_LIVE_PID, time: Date.now(), ownerToken: 'existing-token' }), 'utf-8');

    const l1IsAlive = () => {
      throw new Error('EIO');
    };

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any, l1IsAlive }, lockPath)
    ).rejects.toThrow('EIO');

    // The lock must remain on disk because we could not determine staleness.
    const lockExists = await pathExists(absLockPath);
    expect(lockExists).toBe(true);
  }, 2000);

  it('does not clear lock when PID is alive even if timeout exceeded', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    const staleTime = Date.now() - 6 * 60 * 1000; // older than LOCK_STALE_TIMEOUT_MS (5 min)
    await fs.writeFile(
      absLockPath,
      JSON.stringify({ pid: process.pid, time: staleTime, ownerToken: 'existing-token' }),
      'utf-8',
    );

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath)
    ).rejects.toThrow(/Failed to acquire lock after/);

    // The lock must be preserved because the holder PID is still alive.
    const lockExists = await pathExists(absLockPath);
    expect(lockExists).toBe(true);
  }, 2000);

  it('throws on old-format lock when PID is alive', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // Old schema { pid, time } without ownerToken held by the live current process.
    await fs.writeFile(
      absLockPath,
      JSON.stringify({ pid: process.pid, time: Date.now() }),
      'utf-8',
    );

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath)
    ).rejects.toThrow(/Failed to acquire lock after/);

    // Fail-closed: the old-format live lock must NOT be cleaned up.
    const lockExists = await pathExists(absLockPath);
    expect(lockExists).toBe(true);
  }, 2000);
});

describe('releaseLock', () => {
  it('should delete lock file owned by current process', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });
    await fs.writeFile(absLockPath, JSON.stringify({ pid: process.pid, ownerToken: 'token' }), 'utf-8');

    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath, 'token');

    await expect(fs.access(absLockPath)).rejects.toThrow();
  });

  it('does not delete lock when ownership cannot be verified', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // Corrupt / unparseable lock JSON.
    await fs.writeFile(absLockPath, 'not-json', 'utf-8');

    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath, 'token');

    // Ownership could not be verified — must not delete.
    const lockExists = await pathExists(absLockPath);
    expect(lockExists).toBe(true);
  });

  it('does not delete a lock that was replaced before release', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    const tokenA = 'token-a';
    const tokenB = 'token-b';
    await fs.writeFile(absLockPath, JSON.stringify({ pid: process.pid, ownerToken: tokenA }), 'utf-8');

    // Another owner replaces the lock before we release token A.
    await fs.writeFile(absLockPath, JSON.stringify({ pid: process.pid, ownerToken: tokenB }), 'utf-8');

    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath, tokenA);

    // Lock B must still exist.
    const lockExists = await pathExists(absLockPath);
    expect(lockExists).toBe(true);
    const raw = await fs.readFile(absLockPath, 'utf-8');
    const current = JSON.parse(raw);
    expect(current.ownerToken).toBe(tokenB);
    expect(current.pid).toBe(process.pid);
  }, 2000);

  it('does not delete lock owned by different token (phase 954)', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // First acquire
    const token1 = await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);

    // Simulate stale lock held by a dead PID so the next acquire force-clears and re-acquires
    const staleTime = Date.now() - 6 * 60 * 1000; // older than LOCK_STALE_TIMEOUT_MS (5 min)
    const staleContent = JSON.stringify({ pid: DEAD_PID, time: staleTime, ownerToken: token1 });
    await fs.writeFile(absLockPath, staleContent, 'utf-8');

    // Second acquire clears the stale lock and writes a new ownerToken
    const token2 = await acquireLock({ fs: nodeFs, audit: mockAudit as any }, lockPath);
    expect(token2).not.toBe(token1);
    expect(await fs.stat(absLockPath).then(() => true).catch(() => false)).toBe(true);

    // Releasing with the old token must NOT delete the current lock
    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath, token1);

    expect(await fs.stat(absLockPath).then(() => true).catch(() => false)).toBe(true);
    const raw = await fs.readFile(absLockPath, 'utf-8');
    const current = JSON.parse(raw);
    expect(current.ownerToken).toBe(token2);
    expect(current.pid).toBe(process.pid);
  }, 2000);
});

describe('lockContract', () => {
  it('releases lock when post-acquire verification fails', async () => {
    const contractId = makeContractId('cid');
    const lockPath = 'contracts/cid/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);

    let callCount = 0;
    const dirFn = async () => {
      callCount++;
      if (callCount > 1) {
        throw new Error('verification failed');
      }
      return 'contracts';
    };

    await expect(
      lockContract({ fs: nodeFs, audit: mockAudit as any }, contractId, dirFn)
    ).rejects.toThrow('verification failed');

    // The lock acquired before the verification error must have been released.
    const lockExists = await pathExists(absLockPath);
    expect(lockExists).toBe(false);
  });
});
