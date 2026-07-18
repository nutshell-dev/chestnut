/**
 * ContractSystem lock retry tests (phase 1351 split, phase 1048 适配 per-contender 协议)
 *
 * 覆盖：
 * - 新协议下 claim 被其它存活进程持有时 retry 成功
 * - 新协议下 claim 一直失败时抛 LockContentionExhaustedError
 * - 旧格式 dead-pid progress.lock 迁移成功
 * - 旧格式 live-pid progress.lock 抛 LockConflictError
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { LockConflictError, LockContentionExhaustedError } from '../../src/core/contract/errors.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { DEAD_PID } from '../helpers/dead-pid.js';
import { FAKE_LIVE_PID } from '../helpers/test-pids.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem - lock retry (phase 1351 split + phase 1048)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-locks-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  it('should acquire lock after retry when competing claim is released mid-wait', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Lock Retry Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // phase 1048: 模拟另一个存活进程的 claim
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    const claimsDir = path.join(contractDir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });
    const otherClaimName = `claim.${Date.now() - 1000}.${FAKE_LIVE_PID}.existing-token`;
    await fs.writeFile(
      path.join(claimsDir, otherClaimName),
      JSON.stringify({ pid: FAKE_LIVE_PID, timestamp: Date.now() - 1000, ownerToken: 'existing-token', startTime: '0' }),
      'utf-8',
    );

    const competingClaim = path.join(claimsDir, otherClaimName);
    const lockRetrySleep = vi.fn(async () => {
      // The first lost election is the synchronization barrier: remove the
      // competing claim completely before allowing the next acquire attempt.
      await fs.unlink(competingClaim);
    });

    const contendingManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: makeMockAudit(), toolRegistry: createToolRegistry(), fsFactory,
      lockMaxRetries: 5,
      lockRetryDelayMs: 10,
      lockRetrySleep,
      l1IsAlive: vi.fn(() => true),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    await expect(contendingManager.cancel(contractId, 'checkpoint')).resolves.not.toThrow();
    expect(lockRetrySleep).toHaveBeenCalledTimes(1);
  }, 2000);

  it('should throw LockContentionExhaustedError when lock is never released and retries exhausted', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Lock Exhaust Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // phase 1048: 模拟一个永远存在的竞争 claim
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    const claimsDir = path.join(contractDir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });
    const otherClaimName = `claim.${Date.now() - 1000}.${FAKE_LIVE_PID}.existing-token`;
    await fs.writeFile(
      path.join(claimsDir, otherClaimName),
      JSON.stringify({ pid: FAKE_LIVE_PID, timestamp: Date.now() - 1000, ownerToken: 'existing-token', startTime: '0' }),
      'utf-8',
    );

    const contendingManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: makeMockAudit(), toolRegistry: createToolRegistry(), fsFactory,
      lockMaxRetries: 3,
      lockRetryDelayMs: 10,
      l1IsAlive: vi.fn(() => true),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    await expect(contendingManager.cancel(contractId, 'checkpoint'))
      .rejects.toThrow(LockContentionExhaustedError);
  }, 2000);

  it('migrates dead-pid legacy progress.lock and succeeds', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Legacy Migration Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, time: Date.now(), ownerToken: 'legacy-token' }), 'utf-8');

    await expect(manager.cancel(contractId, 'checkpoint')).resolves.not.toThrow();

    // old lock migrated away
    expect(await fs.access(lockPath).then(() => true).catch(() => false)).toBe(false);
    // claims dir created (cancel moves contract to archive)
    const activeClaimsDir = path.join(clawDir, 'contract', 'active', contractId, 'claims');
    const archiveClaimsDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId, 'claims');
    const claimsCreated = await fs.access(activeClaimsDir).then(() => true).catch(() => false)
      || await fs.access(archiveClaimsDir).then(() => true).catch(() => false);
    expect(claimsCreated).toBe(true);
  }, 2000);

  it('throws LockConflictError when legacy progress.lock is held by live process', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Legacy Live Lock Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, time: Date.now(), ownerToken: 'legacy-token' }), 'utf-8');

    await expect(manager.cancel(contractId, 'checkpoint'))
      .rejects.toThrow(LockConflictError);
  }, 2000);
});
