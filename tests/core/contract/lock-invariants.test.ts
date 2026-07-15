/**
 * Merged test file (test reorganization; no assertion logic changes).
 * Sources:
 *   - lock-retry-jitter.test.ts
 *   - lock-contention-exhausted.test.ts
 *   - lock-contract-atomic.test.ts
 *
 * Note: the constants vi.mock below (LOCK_MAX_RETRIES: 5, LOCK_RETRY_DELAY_MS: 100)
 * comes from lock-retry-jitter.test.ts and is preserved verbatim; the other two
 * sources had no vi.mock (lock-contention-exhausted uses lock.js's own
 * LOCK_CONTRACT_MAX_RETRY, unaffected by the constants mock).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, lockContract, LOCK_CONTRACT_MAX_RETRY } from '../../../src/core/contract/lock.js';
import { LockContentionExhaustedError } from '../../../src/core/contract/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';



/**
 * Phase 1325 — lock retry jitter + per-retry audit emit
 *
 * 反向 3 项:
 * 1. jitter range 实测 100 sample 落 [T/2, 1.5T]
 * 2. per-retry audit emit count = max(0, retries-1)
 * 3. thundering herd simulate (N=10 concurrent) verify wake-up spread
 */
describe('phase 1325 lock retry jitter + audit emit', () => {
  /**
   * Mocked LOCK_RETRY_DELAY_MS value（file-top vi.mock 替 src const 为 100ms 加速 test）.
   * Derivation: 100ms 是 mock 值（src default 500ms）、缩短让 100-sample jitter spread 测试在 ms 级完成 /
   * jitter 算法验 [T/2, 1.5T] 范围 + spread density、与具体 T 无关.
   */
  const MOCKED_LOCK_RETRY_DELAY_MS = 100;

  it('jitter range 100 sample 落 [T/2, 1.5T]', () => {
    const samples = Array.from(
      { length: 100 },
      () => MOCKED_LOCK_RETRY_DELAY_MS / 2 + Math.random() * MOCKED_LOCK_RETRY_DELAY_MS,
    );
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(MOCKED_LOCK_RETRY_DELAY_MS / 2);
    expect(max).toBeLessThanOrEqual(MOCKED_LOCK_RETRY_DELAY_MS * 1.5);
    // spread: not all same value
    const unique = new Set(samples.map(s => Math.round(s))).size;
    expect(unique).toBeGreaterThan(50);
  });

  it('per-retry audit emit count = max(0, retries-1) verify', async () => {
    const mockAudit = makeMockAudit();
    const delays: number[] = [];

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
      delays.push(ms ?? 0);
      return originalSetTimeout(cb, 1); // accelerate to 1ms for fast test
    });

    const mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      writeExclusiveSync: vi.fn(() => {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }),
      read: vi.fn().mockResolvedValue(JSON.stringify({ pid: 12345, time: Date.now(), ownerToken: 'existing-token' })),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      acquireLock({ fs: mockFs as any, audit: mockAudit as any, l1IsAlive: vi.fn(() => true), lockMaxRetries: 5, lockRetryDelayMs: 100 }, '/tmp/test.lock')
    ).rejects.toThrow(/Failed to acquire lock after/);

    // 5 retries → 4 delays → 4 audit emits
    const retryCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.LOCK_RETRY
    );
    expect(retryCalls.length).toBe(4);

    // each emit contains attempt, reason, delay_ms
    expect(retryCalls[0][1]).toMatch(/^attempt=1\/5/);
    expect(retryCalls[0][2]).toMatch(/^reason=/);
    expect(retryCalls[0][3]).toMatch(/^delay_ms=/);

    setTimeoutSpy.mockRestore();
  });

  it('thundering herd N=10 concurrent simulate verify wake-up spread', async () => {
    const mockAudit = makeMockAudit();
    const allDelays: number[] = [];

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
      allDelays.push(ms ?? 0);
      return originalSetTimeout(cb, 1);
    });

    const mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      writeExclusiveSync: vi.fn(() => {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }),
      read: vi.fn().mockResolvedValue(JSON.stringify({ pid: 12345, time: Date.now(), ownerToken: 'existing-token' })),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    // 10 concurrent acquireLock on different lock paths
    const promises = Array.from({ length: 10 }, (_, i) =>
      acquireLock({ fs: mockFs as any, audit: mockAudit as any, l1IsAlive: vi.fn(() => true), lockMaxRetries: 5, lockRetryDelayMs: 100 }, `/tmp/test-${i}.lock`).catch(() => {
        // expected to fail
      })
    );

    await Promise.all(promises);

    // each call retries 5 times → 4 delays → 40 delays total
    expect(allDelays.length).toBe(40);

    // delays should not all be identical (jitter broke synchronization)
    const uniqueDelays = new Set(allDelays.map(d => Math.round(d))).size;
    expect(uniqueDelays).toBeGreaterThan(5);

    // all delays within [T/2, 1.5T]
    for (const d of allDelays) {
      expect(d).toBeGreaterThanOrEqual(MOCKED_LOCK_RETRY_DELAY_MS / 2);
      expect(d).toBeLessThanOrEqual(MOCKED_LOCK_RETRY_DELAY_MS * 1.5);
    }

    setTimeoutSpy.mockRestore();
  });
});

/**
 * LockContentionExhaustedError tests (phase 67 Step D)
 */
describe('LockContentionExhaustedError (phase 67)', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-lock-contention-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    mockAudit = makeMockAudit();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('lock retry budget exhausted → throw typed Error', async () => {
    const dirs = ['a', 'b'];
    for (const d of dirs) {
      await fs.mkdir(path.join(tmpDir, d, 'c1'), { recursive: true });
    }

    let callCount = 0;
    const contractDirFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(dirs[callCount++ % dirs.length]);
    });
    const ctx = { fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 5, lockRetryDelayMs: 100 };

    await expect(lockContract(ctx, 'c1', contractDirFn)).rejects.toThrow(LockContentionExhaustedError);
  });

  it('typed Error fields are correct', async () => {
    const dirs = ['a', 'b'];
    for (const d of dirs) {
      await fs.mkdir(path.join(tmpDir, d, 'c1'), { recursive: true });
    }

    let callCount = 0;
    const contractDirFn = vi.fn().mockImplementation(() => {
      return Promise.resolve(dirs[callCount++ % dirs.length]);
    });
    const ctx = { fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 5, lockRetryDelayMs: 100 };

    try {
      await lockContract(ctx, 'c1', contractDirFn);
    } catch (err) {
      expect(err).toBeInstanceOf(LockContentionExhaustedError);
      expect((err as LockContentionExhaustedError).contractId).toBe('c1');
      expect((err as LockContentionExhaustedError).attempts).toBe(LOCK_CONTRACT_MAX_RETRY);
      expect((err as LockContentionExhaustedError).message).toContain('TOCTOU race retry exhausted');
    }
  });
});

/**
 * lockContract atomic helper tests (phase 1362)
 *
 * Covers TOCTOU race protection between contractDir() and acquireLock().
 */
describe('lock-contract-atomic', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let mockAudit: { write: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-lock-contract-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tmpDir });
    mockAudit = makeMockAudit();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  describe('lockContract (phase 1362)', () => {
    it('happy path: contractDir return dir → acquireLock → re-verify same → return helper', async () => {
      const contractDirFn = vi.fn().mockResolvedValue('active');
      const ctx = { fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 5, lockRetryDelayMs: 100 };

      const result = await lockContract(ctx, 'c1', contractDirFn);

      expect(result.dir).toBe('active');
      expect(result.lockPath).toBe('active/c1/progress.lock');
      expect(typeof result.release).toBe('function');
      expect(contractDirFn).toHaveBeenCalledTimes(2); // before + re-verify
      expect(contractDirFn).toHaveBeenCalledWith('c1');

      const raceRetryCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY
      );
      expect(raceRetryCalls).toHaveLength(0);
    });

    it('race simulate: contractDir returns active → external move → re-verify paused → release + retry', async () => {
      await fs.mkdir(path.join(tmpDir, 'active', 'c1'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'paused', 'c1'), { recursive: true });

      let callCount = 0;
      const dirs = ['active', 'paused', 'paused', 'paused'];
      const contractDirFn = vi.fn().mockImplementation(() => {
        return Promise.resolve(dirs[callCount++]);
      });
      const ctx = { fs: nodeFs, audit: mockAudit as any, lockMaxRetries: 5, lockRetryDelayMs: 100 };

      const result = await lockContract(ctx, 'c1', contractDirFn);

      expect(result.dir).toBe('paused');
      expect(contractDirFn).toHaveBeenCalledTimes(4);

      const raceRetryCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY
      );
      expect(raceRetryCalls).toHaveLength(1);
      expect(raceRetryCalls[0]).toContain('attempt=0');
      expect(raceRetryCalls[0]).toContain('dirBefore=active');
      expect(raceRetryCalls[0]).toContain('dirAfter=paused');
    });

    it('race max retry exhausted: contractDir flips 5+ times → throw exhausted', async () => {
      const dirs = ['a', 'b'];
      for (const d of dirs) {
        await fs.mkdir(path.join(tmpDir, d, 'c1'), { recursive: true });
      }

      let callCount = 0;
      const contractDirFn = vi.fn().mockImplementation(() => {
        // alternate a, b, a, b, ... so before !== after every time
        return Promise.resolve(dirs[callCount++ % dirs.length]);
      });
      const ctx = { fs: nodeFs, audit: mockAudit as any };

      await expect(lockContract(ctx, 'c1', contractDirFn)).rejects.toThrow(
        'TOCTOU race retry exhausted'
      );

      const raceRetryCalls = mockAudit.write.mock.calls.filter((c: any[]) =>
        c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_RACE_RETRY
      );
      // 5 retry emits + 1 exhausted emit
      expect(raceRetryCalls).toHaveLength(6);
      const exhaustedCall = raceRetryCalls[raceRetryCalls.length - 1];
      expect(exhaustedCall).toContain('result=exhausted');
    });
  });

  describe('manager.withProgressLock uses lockContract atomic (phase 1371 sub-1)', () => {
    it('acquires lock via lockContract TOCTOU re-verify (contractDir called twice)', async () => {
      const clawDir = tmpDir;
      const activeDir = path.join(clawDir, 'contract', 'active');
      const contractId = 'test-c1';
      const contractDir = path.join(activeDir, contractId);
      await fs.mkdir(contractDir, { recursive: true });
      await fs.writeFile(
        path.join(contractDir, 'progress.json'),
        JSON.stringify({ schema_version: 1, contract_id: contractId, status: 'running', subtasks: {} }),
      );

      const manager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        lockMaxRetries: 5,
        lockRetryDelayMs: 100,
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});

      const contractDirSpy = vi.spyOn(manager as any, 'contractDir');

      const result = await (manager as any).withProgressLock(contractId, async () => 'locked-value');

      expect(result).toBe('locked-value');
      // lockContract calls contractDirFn twice: before + after lock acquisition (TOCTOU re-verify)
      expect(contractDirSpy).toHaveBeenCalledTimes(2);
      expect(contractDirSpy).toHaveBeenCalledWith(contractId);

      // lock file should be released (deleted) after withProgressLock returns
      const lockPath = path.join(contractDir, 'progress.lock');
      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });
});
