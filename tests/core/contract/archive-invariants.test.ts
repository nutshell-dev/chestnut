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
import { listArchiveContracts } from '../../../src/core/contract/persistence.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { archiveAndEmit } from '../../../src/core/contract/verification-lifecycle.js';
import { createManagerVerificationContext } from '../../helpers/contract-subtask.js';
import { createClawTopology } from '../../../src/core/claw-topology/index.js';

function archiveTopology(nodeFs: NodeFileSystem, chestnutDir: string) {
  return createClawTopology({ fs: nodeFs, chestnutRoot: chestnutDir, motionDir: 'motion' });
}



/**
 * moveContractToArchive lock acquire (phase 860 / P0-B)
 */
describe('moveContractToArchive concurrent lifecycle (phase 1191)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditTypes: string[];

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fsArchiveRace.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditTypes = [];
    const captureAudit = {
      write: (type: string) => {
        auditTypes.push(type);
      },
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

  it('conventional completed archive + cancel end in a valid terminal state', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Lock Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    const progress = await manager.getProgress(contractId);
    progress.subtasks.t1.status = 'completed';
    progress.subtasks.t1.completed_at = new Date().toISOString();
    await (manager as any).saveActiveProgressExisting(contractId, progress);

    // Concurrent: completed archive + cancel on same contract.
    // Directory rename is the sole lifecycle commit point.
    const ctx = createManagerVerificationContext(manager);
    const yaml = await ctx.loadContractYaml(contractId);
    if (!yaml) throw new Error('missing contract yaml');

    const [archiveResult, cancelResult] = await Promise.allSettled([
      archiveAndEmit(ctx, contractId, yaml, 'archive-invariants.race'),
      manager.cancel(contractId, 'concurrent cancel'),
    ]);

    const contractDir = await (manager as any).contractDir(contractId);
    const inArchive =
      contractDir.startsWith('contract/archive/completed') ||
      contractDir.startsWith('contract/archive/cancelled') ||
      contractDir.startsWith('contract/archive/corrupted');
    expect(inArchive).toBe(true);
  });

  it('archiveAndEmit is idempotent when contract already archived', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Already Archived Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
      ],
      verification: [],
    }));

    const progress = await manager.getProgress(contractId);
    progress.subtasks.t1.status = 'completed';
    progress.subtasks.t1.completed_at = new Date().toISOString();
    await (manager as any).saveActiveProgressExisting(contractId, progress);

    // Observe every success side effect: abort, completed handler,
    // completed audit, contract_completed notify.
    const notifyTypes: string[] = [];
    manager.setOnNotify((event) => notifyTypes.push(event.type));
    const completedHandler = vi.fn(async () => {});
    manager.onContractCompleted(completedHandler);

    const ctx = createManagerVerificationContext(manager);
    const abortSpy = vi.fn();
    ctx.abortContractVerifiers = abortSpy;
    const yaml = await ctx.loadContractYaml(contractId);
    if (!yaml) throw new Error('missing contract yaml');

    const first = await archiveAndEmit(ctx, contractId, yaml, 'archive-invariants.idempotent');
    expect(first.archived).toBe(true);

    // The committed request fires exactly one complete success side-effect set.
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(completedHandler).toHaveBeenCalledTimes(1);
    expect(auditTypes.filter(t => t === CONTRACT_AUDIT_EVENTS.COMPLETED)).toHaveLength(1);
    expect(notifyTypes.filter(t => t === 'contract_completed')).toHaveLength(1);

    // Second call returns already_committed; success side effects must not repeat.
    const second = await archiveAndEmit(ctx, contractId, yaml, 'archive-invariants.idempotent');
    expect(second.archived).toBe(false);
    expect(second.state).toBe('completed');

    // already_committed: abort / handler / audit / notify call counts stay frozen.
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(completedHandler).toHaveBeenCalledTimes(1);
    expect(auditTypes.filter(t => t === CONTRACT_AUDIT_EVENTS.COMPLETED)).toHaveLength(1);
    expect(notifyTypes.filter(t => t === 'contract_completed')).toHaveLength(1);
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
    const result = await listArchiveContracts({ fs: nodeFs, clawTopology: archiveTopology(nodeFs, chestnutDir) });
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
    const result = await listArchiveContracts({ fs: nodeFs, clawTopology: archiveTopology(nodeFs, chestnutDir) });

    expect(result).toHaveLength(1);
    expect(result[0].clawId).toBe('c1');
    expect(result[0].contractId).toBe('ct-1');
    expect(result[0].contractDir).toBe(path.join(chestnutDir, 'claws/c1/contract/archive/ct-1'));
    expect(result[0].archivedAt).toBe('2024-01-15T00:00:00Z');
  });

  it('enumerates and resolves claw roots only through the injected topology', async () => {
    const archiveDir = path.join(chestnutDir, 'catalog-root', 'c1', 'contract', 'archive', 'ct-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, 'progress.json'),
      JSON.stringify({ completed_at: '2024-01-15T00:00:00Z' }),
    );
    const nodeFs = new NodeFileSystem({ baseDir: chestnutDir });
    const enumerate = vi.fn(() => ['c1'] as any);
    const resolve = vi.fn(() => ({ kind: 'local' as const, clawDir: path.join(chestnutDir, 'catalog-root', 'c1') }));

    const result = await listArchiveContracts({
      fs: nodeFs,
      clawTopology: { enumerate, resolve },
    });

    expect(enumerate).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('c1');
    expect(result).toHaveLength(1);
    expect(result[0].contractId).toBe('ct-1');
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
      clawTopology: archiveTopology(nodeFs, chestnutDir),
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
    const result = await listArchiveContracts({ fs: nodeFs, clawTopology: archiveTopology(nodeFs, chestnutDir), audit: makeAudit() });

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
    const result = await listArchiveContracts({ fs: nodeFs, clawTopology: archiveTopology(nodeFs, chestnutDir), audit: makeAudit() });

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

    const result = await listArchiveContracts({ fs: nodeFs, clawTopology: archiveTopology(nodeFs, chestnutDir), audit: makeAudit() });

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
    const result = await listArchiveContracts({ fs: nodeFs, clawTopology: archiveTopology(nodeFs, chestnutDir), audit: makeAudit() });

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


/**
 * Phase 1145 Step C: archive getProgress pure-read invariants
 */
describe('archive getProgress pure-read invariants', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fsArchiveRace.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: () => {} } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('reads completed legacy archive without mutation', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Completed Archive',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    const progress = await manager.getProgress(contractId);
    progress.subtasks.t1.status = 'completed';
    progress.subtasks.t1.completed_at = new Date().toISOString();
    await (manager as any).saveActiveProgressExisting(contractId, progress);
    const ctx = createManagerVerificationContext(manager);
    const yaml = await ctx.loadContractYaml(contractId);
    if (!yaml) throw new Error('missing contract yaml');
    await archiveAndEmit(ctx, contractId, yaml, 'archive-invariants.read');

    const archiveRoot = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    const before = await fsArchiveRace.stat(archiveRoot).then(s => s.mtimeMs);

    const archivedProgress = await manager.getProgress(contractId);
    expect(archivedProgress).not.toBeNull();
    expect(archivedProgress.contract_id).toBe(contractId);
    expect(archivedProgress.subtasks.t1.status).toBe('completed');

    const after = await fsArchiveRace.stat(archiveRoot).then(s => s.mtimeMs);
    expect(after).toBe(before);
  });

  it('reads cancelled legacy archive without mutation', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancelled Archive',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    await manager.cancel(contractId, 'invariant test');

    const archiveRoot = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    const before = await fsArchiveRace.stat(archiveRoot).then(s => s.mtimeMs);

    const progress = await manager.getProgress(contractId);
    expect(progress).not.toBeNull();
    expect(progress.contract_id).toBe(contractId);

    const after = await fsArchiveRace.stat(archiveRoot).then(s => s.mtimeMs);
    expect(after).toBe(before);
  });

  it('reads corrupted legacy archive without additional mutation', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Corrupted Archive',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(progressPath, '{ broken json', 'utf-8');

    // First getProgress isolates the broken progress.json, then markCorrupted moves the
    // remaining active directory into archive/corrupted. No further mutation happens.
    await manager.getProgress(contractId);

    const archiveRoot = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
    await expect(fs.access(archiveRoot)).resolves.not.toThrow();

    // Second getProgress is a pure read via archive reader; it must not mutate the archive.
    // Because the corrupt progress.json was isolated away, the payload reader surfaces a
    // missing_payload issue for the corrupted archive.
    const before = await fsArchiveRace.stat(archiveRoot).then(s => s.mtimeMs);
    await expect(manager.getProgress(contractId)).rejects.toThrow('missing_payload');
    const after = await fsArchiveRace.stat(archiveRoot).then(s => s.mtimeMs);
    expect(after).toBe(before);
  });
});
