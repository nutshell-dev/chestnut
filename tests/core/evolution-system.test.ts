import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../src/core/evolution-system/system.js';
import { RetrospectiveStore, SUBMITTED_DIR } from '../../src/core/evolution-system/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeContractId } from '../../src/core/contract/types.js';

const { mockSkillFactory } = vi.hoisted(() => {
  const loadAll = vi.fn().mockResolvedValue(undefined);
  const format = vi.fn().mockReturnValue('No skills loaded');
  return {
    mockSkillFactory: vi.fn(() => ({ loadAll, formatForContext: format })),
  };
});

const { mockSchedulePrepared } = vi.hoisted(() => ({
  mockSchedulePrepared: vi.fn().mockResolvedValue({ taskId: 'mock-task-id', disposition: 'created' }),
}));

interface TestFixtures {
  tmpBase: string;
  motionDir: string;
  clawsBaseDir: string;
  contractId: string;
  ctx: MotionReviewContext;
  evolutionSystem: EvolutionSystem;
  mockAudit: { write: ReturnType<typeof vi.fn> };
  store: RetrospectiveStore;
}

async function setupFixtures(): Promise<TestFixtures> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase1206-system-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const contractId = makeContractId('c-' + randomUUID());

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const mockAudit = {
    write: vi.fn(),
    preview: vi.fn((s: string) => s),
    message: vi.fn((s: string) => s),
    summary: vi.fn((s: string) => s),
  };

  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedulePrepared: mockSchedulePrepared } as any,
    contractManager: {} as any,
    createSkillSystem: mockSkillFactory as any,
  });

  const store = new RetrospectiveStore({ fs: motionFs, audit: mockAudit as any });

  const ctx: MotionReviewContext = {
    motionFs,
    motionBaseDir: motionDir,
    motionAudit: { write: vi.fn() } as any,
    clawsBaseDir,
    clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
    clawContractManagerFactory: vi.fn().mockReturnValue({
      readContractYamlRaw: vi.fn().mockResolvedValue(`contract_id: ${contractId}\nintent: test`),
      getProgress: vi.fn().mockResolvedValue({ completed_at: new Date().toISOString() }),
    }),
  };

  return { tmpBase, motionDir, motionFs, clawsBaseDir, contractId, ctx, evolutionSystem, mockAudit, store };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

describe('EvolutionSystem - disk-state idempotency', () => {
  let fixtures: TestFixtures;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSchedulePrepared.mockResolvedValue({ taskId: 'mock-task-id', disposition: 'created' });
  });

  afterEach(async () => {
    if (fixtures?.tmpBase) {
      await cleanupFixtures(fixtures.tmpBase);
    }
    vi.restoreAllMocks();
  });

  it('concurrent notifyContractCompleted on the same ready row schedules only once', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, store } = fixtures;

    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    const [r1, r2] = await Promise.all([
      evolutionSystem.notifyContractCompleted(contractId, ctx),
      evolutionSystem.notifyContractCompleted(contractId, ctx),
    ]);

    // Exactly one successful submission; the other sees it already submitted.
    const statuses = [r1.status, r2.status];
    expect(statuses).toContain('submitted');
    expect(statuses).toContain('already_dispatching');
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);
  });

  it('second runRetroForContract after submitted returns already_submitted without rescheduling', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, store } = fixtures;

    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    const first = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(first.status).toBe('finished');
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);

    const second = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(second.status).toBe('already_submitted');
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);
  });

  it('notifyContractCompleted persists the row to submitted and removes it from ready', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, store, motionFs } = fixtures;

    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    await evolutionSystem.notifyContractCompleted(contractId, ctx);

    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
  });
});
