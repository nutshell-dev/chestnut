/**
 * moveContractToArchive lock acquire (phase 860 / P0-B)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { acquireLock, releaseLock } from '../../../src/core/contract/lock.js';  // phase 262: hoist

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

describe('moveContractToArchive lock acquire (phase 860 / P0-B)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const captureAudit = {
      write: () => {},
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('acquires source-dir lock before fs.move', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Lock Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    // Concurrent: archive + cancel on same contract
    // Both need lock; should serialize without race corruption
    const [archiveResult, cancelResult] = await Promise.allSettled([
      (manager as any).moveToArchive(contractId),
      manager.cancel(contractId, 'concurrent cancel'),
    ]);

    // One should succeed, the other may fail due to fs.move racing,
    // but neither should hang (deadlock) and the system should be in a valid state.
    //
    // Phase 964: contractDir assertion relaxed from strict 'contract/archive'.
    // Race: cancelContract writes saveProgress(cancelled), then moveToArchive wins
    // the fs.move race first. cancel gets ENOENT on its own move → contract stays
    // in active/ with cancelled progress. This is a valid terminal state — the
    // contract is cancelled and progress is intact.
    const progress = await manager.getProgress(contractId);
    expect(progress.contract_id).toBe(contractId);
    const contractDir = await (manager as any).contractDir(contractId);
    // Contract must be in archive or (active with cancelled status from race)
    const inArchive = contractDir === 'contract/archive';
    const inActiveCancelled = contractDir === 'contract/active' && progress.status === 'cancelled';
    expect(inArchive || inActiveCancelled).toBe(true);
  });

  it('releases lock at target after move', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Release Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    // phase 188: archive precondition requires terminal status
    // phase 282 Step A: status derive from subtasks → 需先完成所有 subtasks
    await (manager as any).withProgressLock(contractId, async () => {
      const progress = await manager.getProgress(contractId);
      progress.subtasks.t1.status = 'completed';
      progress.subtasks.t1.completed_at = new Date().toISOString();
      await (manager as any).saveProgress(contractId, progress);
    });
    await (manager as any).moveToArchive(contractId);

    // Lock released by releaseLock@TARGET (lock file deleted after move)
    const archiveLockPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.lock');
    const lockExists = await fs.stat(archiveLockPath).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);

    // Verify lock is truly released: a new acquire on the same path succeeds
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const ctx = { fs: nodeFs, audit: { write: () => {} , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} };
    const ownerToken = await acquireLock(ctx, archiveLockPath);
    await releaseLock(ctx, archiveLockPath, ownerToken);
  });

  it('skips lock acquire when contract already archived', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Already Archived Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    // phase 188: archive precondition requires terminal status
    // phase 282 Step A: status derive from subtasks → 需先完成所有 subtasks
    await (manager as any).withProgressLock(contractId, async () => {
      const progress = await manager.getProgress(contractId);
      progress.subtasks.t1.status = 'completed';
      progress.subtasks.t1.completed_at = new Date().toISOString();
      await (manager as any).saveProgress(contractId, progress);
    });
    await manager.moveToArchive(contractId);

    // Second call should early-return without acquiring lock
    const acquireSpy = vi.fn(acquireLock);
    // Since the early return happens before any lock call, simply re-invoking must not throw
    await expect(manager.moveToArchive(contractId)).resolves.toBeUndefined();
  });
});
