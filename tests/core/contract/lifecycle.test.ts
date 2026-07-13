/**
 * ContractSystem lifecycle tests (Phase 966)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
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

describe('ContractSystem lifecycle (Phase 966)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: vi.fn(), preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('resets in_progress subtasks when cancelling contract (Phase 967)', async () => {
    const contractId = await manager.create({
      title: 'Cancel Test',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const raw = await fs.readFile(progressPath, 'utf-8');
    const progress = JSON.parse(raw);
    progress.subtasks['task-1'].status = 'in_progress';
    progress.subtasks['task-1'].verification_attempt_id = 'attempt-1';
    await fs.writeFile(progressPath, JSON.stringify(progress, null, 2));

    await manager.cancel(contractId, 'test');

    const archivedProgressPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBe('cancelled');
    expect(archivedProgress.subtasks['task-1'].status).toBe('todo');
    expect(archivedProgress.subtasks['task-1'].verification_attempt_id).toBeUndefined();
  });

  it('resets in_progress subtasks when marking contract crashed (Phase 967)', async () => {
    const contractId = await manager.create({
      title: 'Crash Test',
      goal: 'test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }],
      verification: [],
    });

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    const raw = await fs.readFile(progressPath, 'utf-8');
    const progress = JSON.parse(raw);
    progress.subtasks['task-1'].status = 'in_progress';
    progress.subtasks['task-1'].verification_attempt_id = 'attempt-1';
    await fs.writeFile(progressPath, JSON.stringify(progress, null, 2));

    await manager.markCrashed(contractId, 'test-crash');

    const archivedProgressPath = path.join(clawDir, 'contract', 'archive', contractId, 'progress.json');
    const archivedRaw = await fs.readFile(archivedProgressPath, 'utf-8');
    const archivedProgress = JSON.parse(archivedRaw);
    expect(archivedProgress.status).toBe('crashed');
    expect(archivedProgress.subtasks['task-1'].status).toBe('todo');
    expect(archivedProgress.subtasks['task-1'].verification_attempt_id).toBeUndefined();
  });

  it('resets in_progress subtasks when resuming paused contract', async () => {
    const contractId = 'resume-in-progress';
    const pausedDir = path.join(clawDir, 'contract', 'paused', contractId);
    await fs.mkdir(pausedDir, { recursive: true });

    await fs.writeFile(
      path.join(pausedDir, 'contract.yaml'),
      yaml.dump(makeContractYaml({ id: contractId })),
    );
    await fs.writeFile(
      path.join(pausedDir, 'progress.json'),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        status: 'paused',
        subtasks: {
          'task-1': { status: 'in_progress', verification_attempt_id: 'old-attempt' },
        },
        started_at: new Date().toISOString(),
        checkpoint: 'paused checkpoint',
      }, null, 2),
    );

    await manager.resume(contractId);

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('running');
    expect(progress.checkpoint).toBeNull();
    expect(progress.subtasks['task-1'].status).toBe('todo');
    expect(progress.subtasks['task-1'].verification_attempt_id).toBeUndefined();

    // Verify the contract has moved back to active/
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    expect(await fs.stat(activeDir).then(() => true).catch(() => false)).toBe(true);
  });
});
