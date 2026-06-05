/**
 * Phase 63 Step G: markCrashed unit tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { ToolError } from '../../../src/foundation/errors.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

describe('phase 63: markCrashed', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let notifyCalls: Array<{ type: string; data: Record<string, unknown> }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    notifyCalls = [];
    const captureAudit = {
      write: () => {},
    };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
    });
    manager.setOnNotify((type, data) => {
      notifyCalls.push({ type, data });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('saveProgress(status="crashed") + move to archive + safeNotify', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Crash Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    // create 会触发 contract_created notify、清掉只验 markCrashed 的
    notifyCalls.length = 0;

    await manager.markCrashed(contractId, 'system: maxstepsexceedederror');

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('crashed');
    expect(progress.checkpoint).toBe('crashed: system: maxstepsexceedederror');

    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].type).toBe('contract_crashed');
    expect(notifyCalls[0].data).toMatchObject({
      contractId,
      cause: 'system: maxstepsexceedederror',
    });
  });

  it('throws ToolError if contract already in archive', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Crash Already Archived',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'pre-cancel');
    await expect(manager.markCrashed(contractId, 'cause')).rejects.toThrow(ToolError);
  });

  it('abortContractVerifiers failure does not break main flow', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Crash Abort Throw',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const abortSpy = vi.spyOn(manager as any, '_abortContractVerifiers').mockImplementation(() => {
      throw new Error('verifier abort boom');
    });

    await expect(manager.markCrashed(contractId, 'cause')).resolves.toBeUndefined();

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('crashed');

    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.access(archiveContractDir)).resolves.toBeUndefined();

    abortSpy.mockRestore();
  });

  it('emits CONTRACT_CRASHED audit', async () => {
    const auditWrites: string[][] = [];
    const audit = {
      write: (...args: string[]) => auditWrites.push(args),
    };
    const localManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: audit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
    });

    const contractId = await localManager.create(makeContractYaml({
      title: 'Crash Audit Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await localManager.markCrashed(contractId, 'cause');

    expect(auditWrites.some(a => a[0] === 'contract_crashed' && a.some(s => s.includes('contractId=' + contractId)))).toBe(true);
    expect(auditWrites.some(a => a[0] === 'contract_crashed' && a.some(s => s.includes('cause=cause')))).toBe(true);
  });
});
