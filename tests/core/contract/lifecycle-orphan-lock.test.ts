/**
 * ContractSystem lifecycle orphan lock fix (phase 871 / r113 G fork / new.P1.5)
 * Reverse test: fs.move throw → source lock released + throw propagated
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

describe('phase 871 r113 G fork: contract lock orphan-on-fs-move-throw cluster fix (new.P1.5)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditCalls: Array<{ type: string; args: string[] }>;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
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

  // 反向 1: pauseContract fs.move throw → source lock released + throw propagated + LOCK_UNLINK_FAILED audit
  it('pauseContract: fs.move throws → source lock released + throw propagated + LOCK_UNLINK_FAILED audit', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Orphan Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    // Mock fs.move to throw EXDEV (cross-device)
    const moveSpy = vi.spyOn(nodeFs, 'move').mockRejectedValue(
      Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    );

    const beforeAudit = auditCalls.length;

    await expect(manager.pause(contractId, 'orphan-test')).rejects.toThrow('EXDEV');

    // source lock must be released (deleted)
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    // finally releaseLock(target) emits LOCK_UNLINK_FAILED because target dir was never created
    const lockUnlinkFailedAudits = auditCalls.slice(beforeAudit).filter(
      c => c.type === CONTRACT_AUDIT_EVENTS.LOCK_UNLINK_FAILED
    );
    expect(lockUnlinkFailedAudits.length).toBeGreaterThanOrEqual(1);

    moveSpy.mockRestore();
  });

  // 反向 2: cancelContract fs.move throw → source lock released + throw propagated
  it('cancelContract: fs.move throws → source lock released + throw propagated', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Orphan Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    const moveSpy = vi.spyOn(nodeFs, 'move').mockRejectedValue(
      Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    );

    await expect(manager.cancel(contractId, 'orphan-test')).rejects.toThrow('ENOSPC');

    // source lock must be released
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    moveSpy.mockRestore();
  });

  // 反向 3: moveContractToArchive fs.move throw → source lock released + throw propagated
  it('moveContractToArchive: fs.move throws → source lock released + throw propagated', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Archive Orphan Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // phase 188: archive precondition requires terminal status
    // phase 282 Step A: status derive from subtasks → 需先完成所有 subtasks 才能 archive
    await (manager as any).withProgressLock(contractId, async () => {
      const progress = await manager.getProgress(contractId);
      progress.subtasks.t1.status = 'completed';
      progress.subtasks.t1.completed_at = new Date().toISOString();
      await (manager as any).saveProgress(contractId, progress);
    });

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    const moveSpy = vi.spyOn(nodeFs, 'move').mockRejectedValue(
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    );

    await expect(manager.moveToArchive(contractId)).rejects.toThrow('EBUSY');

    // source lock must be released
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    moveSpy.mockRestore();
  });

  // 反向 4 (optional): happy path verify 0 regression — pause success → target lock released
  it('happy path: pauseContract fs.move success → target lock released + 0 regression', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Happy Path Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const targetLockPath = path.join(clawDir, 'contract', 'paused', contractId, 'progress.lock');

    await manager.pause(contractId, 'happy-path');

    // After successful pause, contract should be in paused/
    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('paused');

    // target lock should NOT exist (releaseLock at target deletes it)
    await expect(fs.access(targetLockPath)).rejects.toThrow();
  });
});
