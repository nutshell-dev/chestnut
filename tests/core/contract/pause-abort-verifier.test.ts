/**
 * pauseContract abort verifier propagation tests (phase 1162 r128 D fork DD3)
 *
 * Coverage:
 * - happy path: pauseContract triggers abortContractVerifiers with paused reason
 * - abort throw doesn't break pause main flow (best-effort outer try/catch)
 * - saveProgress before abort = canonical decision point (crash-safe ratify)
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

describe('pauseContract abort verifier propagation (phase 1162 DD3)', () => {
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
    manager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, captureAudit as any, undefined, createToolRegistry()
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // 反向 1: happy path — pauseContract triggers abortContractVerifiers with 'paused: <checkpoint>' reason
  it('triggers abortContractVerifiers with paused reason', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Abort Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {});

    await manager.pause(contractId, 'checkpoint-note');

    expect(abortSpy).toHaveBeenCalledWith(contractId, 'paused: checkpoint-note');

    abortSpy.mockRestore();
  });

  // 反向 2: abortContractVerifiers throws → catch 不阻断 → saveProgress 已 land + fs.move 仍执行
  it('abort throw does not break pause main flow', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Abort Throw Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    // Should NOT throw — abort is best-effort wrapped in try/catch
    await expect(manager.pause(contractId, 'test abort throw')).resolves.toBeUndefined();

    // saveProgress must have landed before abort was called
    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('paused');

    // contract should be moved to paused
    const pausedContractDir = path.join(clawDir, 'contract', 'paused', contractId);
    await expect(fs.access(pausedContractDir)).resolves.toBeUndefined();

    abortSpy.mockRestore();
  });

  // 反向 3: saveProgress before abort (canonical decision crash-safe ratify)
  it('saveProgress before abort (canonical decision crash-safe ratify)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Order Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    const callOrder: string[] = [];
    const originalSave = (manager as any).saveProgress.bind(manager);
    const originalAbort = (manager as any)._abortContractVerifiers.bind(manager);

    const saveSpy = vi.spyOn(manager as any, 'saveProgress').mockImplementation(async (id: string, p: any) => {
      callOrder.push('save');
      return originalSave(id, p);
    });
    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation((id: string, reason: string) => {
      callOrder.push('abort');
      return originalAbort(id, reason);
    });

    await manager.pause(contractId, 'order-test');

    expect(callOrder).toEqual(['save', 'abort']);

    saveSpy.mockRestore();
    abortSpy.mockRestore();
  });
});
