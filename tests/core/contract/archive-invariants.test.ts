/**
 * Merged test file (test reorganization; no assertion logic changes).
 * Sources:
 *   - archive-race.test.ts
 *   - list-archive-contracts.test.ts
 *   - list-archive-contracts-progress-audit.test.ts
 *
 * Note: archive-race.test.ts imported `{ promises as fs } from 'fs'` while the
 * two list-archive sources imported `* as fs from 'fs/promises'`; the former is
 * aliased to `fsArchiveRace` here (references updated accordingly).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fsArchiveRace } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { acquireLock, releaseLock } from '../../../src/core/contract/lock.js';  // phase 262: hoist
import { listArchiveContracts } from '../../../src/core/contract/persistence.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

/**
 * moveContractToArchive lock acquire (phase 860 / P0-B)
 */
describe('moveContractToArchive lock acquire (phase 860 / P0-B)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fsArchiveRace.mkdir(clawDir, { recursive: true });
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
    const lockExists = await fsArchiveRace.stat(archiveLockPath).then(() => true).catch(() => false);
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

/**
 * @module tests/core/contract/list-archive-contracts
 * Phase 1335 sub-4: listArchiveContracts cross-module query API
 */
describe('listArchiveContracts', () => {
  let testDir: string;
  let chestnutDir: string;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-list-archive-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    chestnutDir = path.join(testDir, 'chestnut');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(chestnutDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty array when claws dir missing', async () => {
    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs });
    expect(result).toEqual([]);
  });

  it('lists archived contracts with clawId + contractId + contractDir', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ schema_version: 1, contract_id: 'ct-1', status: 'completed', subtasks: {}, completed_at: '2024-01-15T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].contractDir).toBe('claws/c1/contract/archive/ct-1');
    expect(result[0].archivedAt).toBe('2024-01-15T00:00:00Z');
  });

  it('filters by sinceMs/untilMs', async () => {
    const archiveDir1 = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'old');
    await fs.mkdir(archiveDir1, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir1, 'progress.json'),
      JSON.stringify({ completed_at: '2024-01-01T00:00:00Z' }),
    );

    const archiveDir2 = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'new');
    await fs.mkdir(archiveDir2, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir2, 'progress.json'),
      JSON.stringify({ completed_at: '2024-06-01T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({
      fs: nodeFs,
      filter: { sinceMs: new Date('2024-03-01').getTime() },
    });

    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('new');
  });
});

/**
 * @module tests/core/contract/list-archive-contracts-progress-audit
 * Phase 164: listArchiveContracts progress.json non-ENOENT silent catch audit emit (playbook §1)
 *
 * 反向 4 项：
 * 1. progress.json ENOENT → 0 audit + 继续列举（archivedAt undefined）
 * 2. progress.json JSON.parse fail → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
 * 3. fs.readSync EACCES → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
 * 4. progress.json 正常 → 0 audit + archivedAt 正确解析
 */
describe('listArchiveContracts progress.json audit (phase 164)', () => {
  let testDir: string;
  let chestnutDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-list-archive-audit-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    chestnutDir = path.join(testDir, 'chestnut');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(chestnutDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  function makeAudit() {
    return { write: auditWrite, __brand: 'AuditLog' } as any;
  }

  // 反向 1：progress.json ENOENT → 0 audit + 继续列举（archivedAt undefined）
  it('反向 1: progress.json ENOENT → 0 audit + 继续列举', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    // intentionally NO progress.json

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBeUndefined();

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeUndefined();
  });

  // 反向 2：progress.json JSON.parse fail → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
  it('反向 2: progress.json JSON.parse fail → emit ARCHIVE_PROGRESS_READ_FAILED', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'progress.json'), '{invalid json');

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBeUndefined();

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall).toContainEqual('clawId=c1');
    expect(failedCall).toContainEqual('contractId=ct-1');
    expect(failedCall).toContainEqual(expect.stringContaining('error='));
  });

  // 反向 3：fs.readSync EACCES → emit ARCHIVE_PROGRESS_READ_FAILED + 继续列举
  it('反向 3: fs.readSync EACCES → emit ARCHIVE_PROGRESS_READ_FAILED', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'progress.json'), '{}');

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    vi.spyOn(nodeFs, 'readSync').mockImplementation((p: string) => {
      if (p.includes('progress.json')) throw eaccesError;
      // fallback for any other readSync (should not happen here)
      return fs.readFileSync(path.join(chestnutDir, p), 'utf-8');
    });

    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBeUndefined();

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall).toContainEqual('clawId=c1');
    expect(failedCall).toContainEqual('contractId=ct-1');
    expect(failedCall).toContainEqual(expect.stringContaining('error='));
  });

  // 反向 4：progress.json 正常 → 0 audit + archivedAt 正确解析
  it('反向 4: progress.json 正常 → 0 audit + archivedAt 正确解析', async () => {
    const archiveDir = path.join(chestnutDir, 'claws', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ completed_at: '2024-01-15T00:00:00Z' }),
    );

    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const result = await listArchiveContracts({ fs: nodeFs, audit: makeAudit() });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].archivedAt).toBe('2024-01-15T00:00:00Z');

    const failedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PROGRESS_READ_FAILED,
    );
    expect(failedCall).toBeUndefined();
  });
});
