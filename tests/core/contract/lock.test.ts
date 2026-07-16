/**
 * Contract Lock 子模块测试
 *
 * Phase 1048: 迁移到 per-contender 文件锁协议。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, releaseLock, lockContract } from '../../../src/core/contract/lock.js';
import { LockConflictError, LockContentionExhaustedError } from '../../../src/core/contract/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { DEAD_PID } from '../../helpers/dead-pid.js';
import { FAKE_LIVE_PID } from '../../helpers/test-pids.js';
import { makeContractId } from '../../../src/core/contract/types.js';

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
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

describe('acquireLock (per-contender protocol)', () => {
  it('writes a claim file and returns ownerToken', async () => {
    const lockPath = 'test/progress.lock';
    const lockDir = path.join(tmpDir, 'test');
    const claimsDir = path.join(lockDir, 'claims');

    const token = await acquireLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath);

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    const claims = await fs.readdir(claimsDir);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatch(/^claim\.\d+\.\d+\.[a-zA-Z0-9_-]+$/);

    const absClaim = path.join(claimsDir, claims[0]);
    const raw = await fs.readFile(absClaim, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.timestamp).toBe('number');
    expect(parsed.ownerToken).toBe(token);
    expect(typeof parsed.startTime).toBe('string');
  }, 2000);

  it('recovers a stale claim from a dead PID and wins', async () => {
    const lockPath = 'test/progress.lock';
    const lockDir = path.join(tmpDir, 'test');
    const claimsDir = path.join(lockDir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });

    const staleToken = 'stale-token';
    const staleClaimName = `claim.${Date.now() - 1000}.${DEAD_PID}.${staleToken}`;
    await fs.writeFile(
      path.join(claimsDir, staleClaimName),
      JSON.stringify({ pid: DEAD_PID, timestamp: Date.now() - 1000, ownerToken: staleToken, startTime: '0' }),
      'utf-8',
    );

    const token = await acquireLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath);

    expect(token).toBeTruthy();
    // stale claim removed
    expect(await pathExists(path.join(claimsDir, staleClaimName))).toBe(false);
    // our claim exists
    const claims = await fs.readdir(claimsDir);
    expect(claims.some(name => name.endsWith(token))).toBe(true);

    const migratedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === 'lock_claim_stale_recovered'
    );
    expect(migratedCalls).toHaveLength(1);
  }, 2000);

  it('loses election when another live contender holds an earlier claim', async () => {
    const lockPath = 'test/progress.lock';
    const lockDir = path.join(tmpDir, 'test');
    const claimsDir = path.join(lockDir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });

    const otherToken = 'other-token';
    const otherClaimName = `claim.${Date.now() - 1000}.${FAKE_LIVE_PID}.${otherToken}`;
    await fs.writeFile(
      path.join(claimsDir, otherClaimName),
      JSON.stringify({ pid: FAKE_LIVE_PID, timestamp: Date.now() - 1000, ownerToken: otherToken, startTime: '0' }),
      'utf-8',
    );

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any, l1IsAlive: () => true, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath)
    ).rejects.toThrow(LockContentionExhaustedError);

    // other claim preserved
    expect(await pathExists(path.join(claimsDir, otherClaimName))).toBe(true);
  }, 2000);

  it('legacy dead-pid progress.lock is migrated to claims/', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    const absLockDir = path.dirname(absLockPath);
    await fs.mkdir(absLockDir, { recursive: true });

    await fs.writeFile(
      absLockPath,
      JSON.stringify({ pid: DEAD_PID, time: Date.now(), ownerToken: 'legacy-token' }),
      'utf-8',
    );

    const token = await acquireLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath);

    expect(token).toBeTruthy();
    // old lock gone
    expect(await pathExists(absLockPath)).toBe(false);
    // claims created
    const claimsDir = path.join(absLockDir, 'claims');
    const claims = await fs.readdir(claimsDir);
    expect(claims.some(name => name.endsWith(token))).toBe(true);

    const migratedCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
      c[0] === CONTRACT_AUDIT_EVENTS.LOCK_CLAIM_LEGACY_FORMAT_MIGRATED
    );
    expect(migratedCalls).toHaveLength(1);
  }, 2000);

  it('legacy live-pid progress.lock throws LockConflictError', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    await fs.writeFile(
      absLockPath,
      JSON.stringify({ pid: process.pid, time: Date.now(), ownerToken: 'legacy-token' }),
      'utf-8',
    );

    await expect(
      acquireLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath)
    ).rejects.toThrow(LockConflictError);

    // old lock preserved
    expect(await pathExists(absLockPath)).toBe(true);
  }, 2000);

  it('legacy unparseable progress.lock is migrated', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    const absLockDir = path.dirname(absLockPath);
    await fs.mkdir(absLockDir, { recursive: true });

    await fs.writeFile(absLockPath, 'not-json', 'utf-8');

    const token = await acquireLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath);

    expect(token).toBeTruthy();
    expect(await pathExists(absLockPath)).toBe(false);
    const claimsDir = path.join(absLockDir, 'claims');
    const claims = await fs.readdir(claimsDir);
    expect(claims.some(name => name.endsWith(token))).toBe(true);
  }, 2000);
});

describe('releaseLock (per-contender protocol)', () => {
  it('deletes its own claim file', async () => {
    const lockPath = 'test/progress.lock';
    const token = await acquireLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath);

    const claimsDir = path.join(tmpDir, 'test', 'claims');
    const claimsBefore = await fs.readdir(claimsDir);
    expect(claimsBefore.some(name => name.endsWith(token))).toBe(true);

    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath, token);

    const claimsAfter = await fs.readdir(claimsDir);
    expect(claimsAfter.some(name => name.endsWith(token))).toBe(false);
  }, 2000);

  it('removes the disk claim before waking the next in-process waiter', async () => {
    const lockPath = 'test/progress.lock';
    const ctx = { fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 1, lockRetryDelayMs: 1 };
    const firstToken = await acquireLock(ctx, lockPath);

    const originalDelete = nodeFs.delete.bind(nodeFs);
    let finishDelete!: () => void;
    const deleteBarrier = new Promise<void>(resolve => { finishDelete = resolve; });
    const deleteStarted = new Promise<void>(resolve => {
      vi.spyOn(nodeFs, 'delete').mockImplementation(async (relativePath) => {
        if (relativePath.includes(firstToken)) {
          resolve();
          await deleteBarrier;
        }
        return originalDelete(relativePath);
      });
    });

    const releasing = releaseLock(ctx, lockPath, firstToken);
    await deleteStarted;

    let secondAcquired = false;
    const second = acquireLock(ctx, lockPath).then(token => {
      secondAcquired = true;
      return token;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    finishDelete();
    await releasing;
    const secondToken = await second;
    expect(secondToken).toBeTruthy();
    await releaseLock(ctx, lockPath, secondToken);
  }, 2000);

  it('does not delete a claim owned by a different token', async () => {
    const lockPath = 'test/progress.lock';
    const lockDir = path.join(tmpDir, 'test');
    const claimsDir = path.join(lockDir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });

    const otherToken = 'other-token';
    const otherClaimName = `claim.${Date.now()}.${process.pid}.${otherToken}`;
    await fs.writeFile(
      path.join(claimsDir, otherClaimName),
      JSON.stringify({ pid: process.pid, timestamp: Date.now(), ownerToken: otherToken, startTime: '0' }),
      'utf-8',
    );

    await releaseLock({ fs: nodeFs, audit: mockAudit as any }, lockPath, 'wrong-token');

    expect(await pathExists(path.join(claimsDir, otherClaimName))).toBe(true);
  }, 2000);
});

describe('releaseLock (legacy fallback)', () => {
  it('deletes lock file owned by current process', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });
    await fs.writeFile(absLockPath, JSON.stringify({ pid: process.pid, ownerToken: 'token' }), 'utf-8');

    await releaseLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath, 'token');

    await expect(fs.access(absLockPath)).rejects.toThrow();
  });

  it('does not delete lock when ownership cannot be verified', async () => {
    const lockPath = 'test/progress.lock';
    const absLockPath = path.join(tmpDir, lockPath);
    await fs.mkdir(path.dirname(absLockPath), { recursive: true });

    // Corrupt / unparseable lock JSON.
    await fs.writeFile(absLockPath, 'not-json', 'utf-8');

    await releaseLock({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, lockPath, 'token');

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
});

describe('lockContract', () => {
  it('releases lock when post-acquire verification fails', async () => {
    const contractId = makeContractId('cid');
    const lockDir = path.join(tmpDir, 'contracts', 'cid');
    const claimsDir = path.join(lockDir, 'claims');

    let callCount = 0;
    const dirFn = async () => {
      callCount++;
      if (callCount > 1) {
        throw new Error('verification failed');
      }
      return 'contracts';
    };

    await expect(
      lockContract({ fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 3, lockRetryDelayMs: 10 }, contractId, dirFn)
    ).rejects.toThrow('verification failed');

    // The lock acquired before the verification error must have been released.
    // The empty claims/ directory may remain; we only assert no claim files.
    const claims = await fs.readdir(claimsDir).catch(() => [] as string[]);
    const activeClaims = claims.filter(name => name.startsWith('claim.'));
    expect(activeClaims).toHaveLength(0);
  });
});
