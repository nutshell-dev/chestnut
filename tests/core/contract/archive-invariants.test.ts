/**
 * Merged test file (test reorganization; no assertion logic changes).
 * Sources:
 *   - archive-race.test.ts
 *   - archive-getprogress-pure-read tests
 *
 * Phase 1370 Step C: legacy `listArchiveContracts` describe blocks removed together
 * with the deleted legacy listing surface; archive race tests are kept.
 *
 * Note: archive-race.test.ts imported `{ promises as fs } from 'fs'` while the
 * two list-archive sources imported `* as fs from 'fs/promises'`; the former is
 * aliased to `fsArchiveRace` here (references updated accordingly).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fsArchiveRace } from 'fs';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { archiveAndEmit } from '../../../src/core/contract/verification-lifecycle.js';
import { createManagerVerificationContext } from '../../helpers/contract-subtask.js';



/**
 * moveContractToArchive lock acquire (phase 860 / P0-B)
 */
describe('moveContractToArchive concurrent lifecycle (phase 1191)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  /** phase 1872 Step F: 构造期 onNotify holder（测试在断言前指向当次收集器）。 */
  let onNotifySink: ((event: { type: string }) => void) | undefined;
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
    onNotifySink = undefined;
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
    // phase 1872 Step F: onNotify 构造参数一次固定（setter 退役）——测试经 holder 指向当次收集器。
    onNotify: (event) => onNotifySink?.(event),});
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
    onNotifySink = (event) => notifyTypes.push(event.type);
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
