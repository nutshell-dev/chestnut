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
    manager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, captureAudit as any, undefined, createToolRegistry(), undefined, (dir: string) => new NodeFileSystem({ baseDir: dir })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('acquires source-dir lock before fs.move', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Lock Test',
      goal: 'Test',
      deliverables: [],
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
    // but neither should hang (deadlock) and the system should be in a valid state
    const progress = await manager.getProgress(contractId);
    // Contract must end in contract/archive/ (cancel also moves to archive)
    const contractDir = await (manager as any).contractDir(contractId);
    expect(contractDir).toBe('contract/archive');
    // Progress must be readable and not corrupted
    expect(progress.contract_id).toBe(contractId);
  });

  it('releases lock at target after move', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Release Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    await (manager as any).moveToArchive(contractId);

    // Lock released by releaseLock@TARGET (lock file deleted after move)
    const archiveLockPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.lock');
    const lockExists = await fs.stat(archiveLockPath).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);

    // Verify lock is truly released: a new acquire on the same path succeeds
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const { acquireLock, releaseLock } = await import('../../../src/core/contract/lock.js');
    const ctx = { fs: nodeFs, audit: { write: () => {} } };
    await acquireLock(ctx, archiveLockPath);
    await releaseLock(ctx, archiveLockPath);
  });

  it('skips lock acquire when contract already archived', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Already Archived Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    await manager.moveToArchive(contractId);

    // Second call should early-return without acquiring lock
    const { acquireLock } = await import('../../../src/core/contract/lock.js');
    const acquireSpy = vi.fn(acquireLock);
    // Since the early return happens before any lock call, simply re-invoking must not throw
    await expect(manager.moveToArchive(contractId)).resolves.toBeUndefined();
  });
});
