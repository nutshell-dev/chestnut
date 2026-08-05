import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { statSync } from 'node:fs';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { RetrospectiveStore } from '../../../src/core/evolution-system/retrospective-store.js';
import { READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR } from '../../../src/core/evolution-system/retrospective-store.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { makeFullTaskId, type FullTaskId } from '../../../src/core/async-task-system/types.js';
import { createTestTaskSystem } from '../../helpers/task-system.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from '../../../src/core/async-task-system/dirs.js';
import { buildRetroSubagentPayload } from '../../../src/core/evolution-system/retro-scheduler.js';

const { mockSkillFactory } = vi.hoisted(() => {
  const loadAll = vi.fn().mockResolvedValue(undefined);
  const format = vi.fn().mockReturnValue('No skills loaded');
  return {
    mockSkillFactory: vi.fn(() => ({ loadAll, formatForContext: format })),
  };
});

interface TestFixtures {
  tmpBase: string;
  motionDir: string;
  motionFs: NodeFileSystem;
  clawsBaseDir: string;
  targetClawDir: string;
  contractId: string;
  ctx: MotionReviewContext;
  evolutionSystem: EvolutionSystem;
  mockAudit: { write: ReturnType<typeof vi.fn> };
  store: RetrospectiveStore;
}

async function setupFixtures(): Promise<TestFixtures> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase1206-recovery-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const targetClawDir = path.join(clawsBaseDir, targetClaw);
  const contractId = makeContractId('c-' + randomUUID());

  await fs.mkdir(motionDir, { recursive: true });
  await fs.mkdir(path.join(targetClawDir, 'contract', 'active', contractId), { recursive: true });

  const contractYamlPath = path.join(targetClawDir, 'contract', 'active', contractId, 'contract.yaml');
  await fs.writeFile(contractYamlPath, `contract_id: ${contractId}\nintent: test`);
  const progressPath = path.join(targetClawDir, 'contract', 'active', contractId, 'progress.json');
  await fs.writeFile(
    progressPath,
    JSON.stringify({
      schema_version: 1,
      contract_id: contractId,
      status: 'completed',
      subtasks: {},
      completed_at: new Date().toISOString(),
    }),
  );

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const mockAudit = {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };

  const auditWriter = mockAudit as any;
  const taskSystem = createTestTaskSystem(motionDir, motionFs, auditWriter);

  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: auditWriter,
    taskSystem,
    contractManager: {} as any,
    createSkillSystem: mockSkillFactory as any,
  });

  const store = new RetrospectiveStore({ fs: motionFs, audit: auditWriter });

  const ctx: MotionReviewContext = {
    motionFs,
    motionBaseDir: motionDir,
    motionAudit: { write: vi.fn() } as any,
    clawsBaseDir,
    clawFsFactory: (clawDir: string) => new NodeFileSystem({ baseDir: clawDir }),
    clawContractManagerFactory: vi.fn().mockReturnValue({
      readContractYamlRaw: vi.fn().mockResolvedValue(`contract_id: ${contractId}\nintent: test`),
      getProgress: vi.fn().mockResolvedValue({ completed_at: new Date().toISOString() }),
    }),
  };

  return { tmpBase, motionDir, motionFs, clawsBaseDir, targetClawDir, contractId, ctx, evolutionSystem, mockAudit, store };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

function writeDispatchingRow(
  motionFs: NodeFileSystem,
  contractId: string,
  taskId: FullTaskId,
  createdAt: string,
  targetClaw = 'claw-a',
): Promise<void> {
  const row = {
    schema_version: 1,
    contract_id: contractId,
    task_id: taskId,
    target_claw: targetClaw,
    created_at: createdAt,
    mode: 'shadow',
  };
  return motionFs.writeAtomic(`${DISPATCHING_DIR}/${contractId}.json`, JSON.stringify(row, null, 2));
}

function writeSubmittedRow(
  motionFs: NodeFileSystem,
  contractId: string,
  taskId: FullTaskId,
  createdAt: string,
  targetClaw = 'claw-a',
): Promise<void> {
  const row = {
    schema_version: 1,
    contract_id: contractId,
    task_id: taskId,
    target_claw: targetClaw,
    created_at: createdAt,
    mode: 'shadow',
  };
  return motionFs.writeAtomic(`${SUBMITTED_DIR}/${contractId}.json`, JSON.stringify(row, null, 2));
}

describe('EvolutionSystem recovery crash matrix (Phase 1206 Step E)', () => {
  let fixtures: TestFixtures;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (fixtures?.tmpBase) {
      await cleanupFixtures(fixtures.tmpBase);
    }
  });

  it('A: ready row + contract completed → notifyContractCompleted submits', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, store, motionFs } = fixtures;

    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);

    expect(result.status).toBe('submitted');
    expect(result.taskId).toBeTruthy();
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${READY_DIR}/${contractId}.json`)).toBe(false);
  });

  it('B: dispatching row + task absent → recoverRetrospectives recovers to submitted', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, motionFs } = fixtures;

    const taskId = makeFullTaskId('00000000-0000-0000-0000-000000000001');
    const createdAt = new Date().toISOString();
    await writeDispatchingRow(motionFs, contractId, taskId, createdAt);

    const result = await evolutionSystem.recoverRetrospectives(ctx);

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${DISPATCHING_DIR}/${contractId}.json`)).toBe(false);
    expect(await motionFs.exists(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`)).toBe(true);
  });

  it('C: dispatching row + task in each lifecycle dir → recover returns submitted via existing identity', async () => {
    const dirs = [TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR, TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR];

    for (const dir of dirs) {
      fixtures = await setupFixtures();
      const { contractId, ctx, evolutionSystem, motionFs, motionAudit } = fixtures;

      const taskId = makeFullTaskId('00000000-0000-0000-0000-000000000002');
      const createdAt = new Date().toISOString();
      await writeDispatchingRow(motionFs, contractId, taskId, createdAt);

      // Build the exact payload that submitDispatching will produce.
      const payload = await buildRetroSubagentPayload({
        targetClaw: 'claw-a',
        contractId,
        contractYaml: `contract_id: ${contractId}\nintent: test`,
        motionFs,
        audit: motionAudit as any,
        createSkillSystem: mockSkillFactory as any,
      });

      const taskFile = {
        ...payload,
        id: taskId,
        shortId: taskId.slice(0, 8),
        createdAt,
      };
      await motionFs.ensureDir(dir);
      await motionFs.writeAtomic(`${dir}/${taskId}.json`, JSON.stringify(taskFile, null, 2));

      const beforeStat = statSync(path.join(motionDirFor(fixtures), `${dir}/${taskId}.json`));

      const result = await evolutionSystem.recoverRetrospectives(ctx);

      expect(result.recovered).toBe(1);
      expect(result.failed).toBe(0);
      expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
      expect(await motionFs.exists(`${DISPATCHING_DIR}/${contractId}.json`)).toBe(false);

      const afterStat = statSync(path.join(motionDirFor(fixtures), `${dir}/${taskId}.json`));
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    }
  });

  it('D: submitted row exists → recoverRetrospectives does not schedule again', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, motionFs } = fixtures;

    const taskId = makeFullTaskId('00000000-0000-0000-0000-000000000003');
    const createdAt = new Date().toISOString();
    await writeSubmittedRow(motionFs, contractId, taskId, createdAt);

    const result = await evolutionSystem.recoverRetrospectives(ctx);

    expect(result.recovered).toBe(0);
    expect(result.driven).toBe(0);
    expect(result.failed).toBe(0);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`)).toBe(false);
  });

  it('B: schedule failure keeps dispatching row and second recovery succeeds', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, motionFs } = fixtures;

    const taskId = makeFullTaskId('00000000-0000-0000-0000-000000000004');
    const createdAt = new Date().toISOString();
    await writeDispatchingRow(motionFs, contractId, taskId, createdAt);

    // Inject a schedule failure on the first call.
    const originalSchedulePrepared = (evolutionSystem as any).deps.taskSystem.schedulePrepared.bind((evolutionSystem as any).deps.taskSystem);
    let calls = 0;
    (evolutionSystem as any).deps.taskSystem.schedulePrepared = async (...args: any[]) => {
      calls++;
      if (calls === 1) throw new Error('injected schedule failure');
      return originalSchedulePrepared(...args);
    };

    const first = await evolutionSystem.recoverRetrospectives(ctx);
    expect(first.recovered).toBe(0);
    expect(first.failed).toBe(1);
    expect(await motionFs.exists(`${DISPATCHING_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(false);

    const second = await evolutionSystem.recoverRetrospectives(ctx);
    expect(second.recovered).toBe(1);
    expect(second.failed).toBe(0);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${DISPATCHING_DIR}/${contractId}.json`)).toBe(false);
  });

  it('B/C: markSubmitted failure keeps dispatching row and second recovery succeeds', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, motionFs } = fixtures;

    const taskId = makeFullTaskId('00000000-0000-0000-0000-000000000005');
    const createdAt = new Date().toISOString();
    await writeDispatchingRow(motionFs, contractId, taskId, createdAt);

    // Inject a markSubmitted failure on the first call.
    const store = (evolutionSystem as any).store;
    const originalMarkSubmitted = store.markSubmitted.bind(store);
    let calls = 0;
    store.markSubmitted = async (id: string) => {
      calls++;
      if (calls === 1) throw new Error('injected markSubmitted failure');
      return originalMarkSubmitted(id);
    };

    const first = await evolutionSystem.recoverRetrospectives(ctx);
    expect(first.recovered).toBe(0);
    expect(first.failed).toBe(1);
    expect(await motionFs.exists(`${DISPATCHING_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(false);

    const second = await evolutionSystem.recoverRetrospectives(ctx);
    expect(second.recovered).toBe(1);
    expect(second.failed).toBe(0);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${DISPATCHING_DIR}/${contractId}.json`)).toBe(false);
  });

  it('one item failure does not block another and failed counter is exact', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, motionFs } = fixtures;

    const okTaskId = makeFullTaskId('00000000-0000-0000-0000-000000000006');
    const failTaskId = makeFullTaskId('00000000-0000-0000-0000-000000000007');
    const createdAt = new Date().toISOString();

    await writeDispatchingRow(motionFs, contractId, okTaskId, createdAt);
    await writeDispatchingRow(motionFs, makeContractId('fail-contract'), failTaskId, createdAt);

    // Make the fail-contract row break during prepared build (missing yaml).
    (evolutionSystem as any).deps.taskSystem.schedulePrepared = async (_kind: string, prepared: any) => {
      if (prepared.id === failTaskId) throw new Error('injected per-item failure');
      return { taskId: prepared.id, disposition: 'created' };
    };

    const result = await evolutionSystem.recoverRetrospectives(ctx);

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${DISPATCHING_DIR}/${makeContractId('fail-contract')}.json`)).toBe(true);
  });
});

function motionDirFor(fixtures: TestFixtures): string {
  return fixtures.motionDir;
}
