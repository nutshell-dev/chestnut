/**
 * Phase 1152 G.5: cancelContract saveProgress-before-abort op-order reverse tests
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

describe('phase 1152 G.5: cancelContract saveProgress before abort order', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
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

  it('phase 63: cancelContract triggers safeNotify("contract_cancelled")', async () => {
    const notifyCalls: Array<{ type: string; data: Record<string, unknown> }> = [];
    manager.setOnNotify((type, data) => {
      notifyCalls.push({ type, data });
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Notify Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    // create triggers contract_created notify, clear to only verify cancel
    notifyCalls.length = 0;

    await manager.cancel(contractId, 'user cancelled');

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].type).toBe('contract_cancelled');
    expect(notifyCalls[0].data).toMatchObject({
      contractId,
      reason: 'user cancelled',
    });
  });

  // 反向 1: happy path — cancelContract 后 progress.json status='cancelled' + contract 在 archive dir
  it('happy path: cancel saves progress as cancelled then moves to archive', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Order Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'user cancelled');

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');
    expect(progress.checkpoint).toBe('cancelled: user cancelled');

    // contract should be in archive dir
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();
  });

  // 反向 2: abortContractVerifiers throws → catch 不阻断 → saveProgress 已 land + fs.move 仍执行
  it('abort throw: saveProgress lands before abort, catch does not block move', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Abort Throw Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    // Should NOT throw — abort is best-effort wrapped in try/catch
    await expect(manager.cancel(contractId, 'test abort throw')).resolves.toBeUndefined();

    // saveProgress must have landed before abort was called
    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');

    // contract should still be moved to archive
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    abortSpy.mockRestore();
  });

  // 反向 3: saveProgress reject → catch 块 releaseLock(source) + throw / lock 不 orphan
  it('saveProgress reject: source lock released + throw propagated', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Save Reject Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const sourceLockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');

    const saveSpy = vi.spyOn(manager as any, 'saveProgress').mockRejectedValue(
      new Error('ENOSPC: no space left on device')
    );

    await expect(manager.cancel(contractId, 'test save reject')).rejects.toThrow('ENOSPC');

    // source lock must be released (deleted)
    await expect(fs.access(sourceLockPath)).rejects.toThrow();

    saveSpy.mockRestore();
  });
});
