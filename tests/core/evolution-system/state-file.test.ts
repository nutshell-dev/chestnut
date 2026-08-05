import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { RetrospectiveStore } from '../../../src/core/evolution-system/index.js';
import { READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR } from '../../../src/core/evolution-system/retrospective-store.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT } from '../../../src/core/evolution-system/retro-scheduler.js';
import { makeContractId } from '../../../src/core/contract/types.js';

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

async function setupFixtures(overrides?: {
  retroSubagentTimeoutMs?: number;
}): Promise<TestFixtures> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase1206-state-${randomUUID()}`);
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
    retroSubagentTimeoutMs: overrides?.retroSubagentTimeoutMs,
    createSkillSystem: mockSkillFactory as any,
  });

  const store = new RetrospectiveStore({ fs: motionFs, audit: mockAudit as any });

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

  return { tmpBase, motionDir, motionFs, clawsBaseDir, contractId, ctx, evolutionSystem, mockAudit, store };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

describe('EvolutionSystem disk-state dispatch', () => {
  let fixtures: TestFixtures;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSchedulePrepared.mockResolvedValue({ taskId: 'mock-task-id', disposition: 'created' });
  });

  afterEach(async () => {
    if (fixtures?.tmpBase) {
      await cleanupFixtures(fixtures.tmpBase);
    }
  });

  it('notifyContractCompleted returns missing_work_item when no ready row exists', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem } = fixtures;

    const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);

    expect(result.status).toBe('missing_work_item');
    expect(mockSchedulePrepared).not.toHaveBeenCalled();
  });

  it('registering a ready row then notifyContractCompleted returns submitted and schedules the task', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, store, motionFs } = fixtures;

    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);

    expect(result.status).toBe('submitted');
    expect(result.taskId).toBe('mock-task-id');
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);
    expect(mockSchedulePrepared).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({
        id: expect.any(String),
        createdAt: expect.any(String),
        payload: expect.objectContaining({ kind: 'subagent' }),
      }),
    );

    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${READY_DIR}/${contractId}.json`)).toBe(false);
  });

  it('calling notifyContractCompleted twice returns already_submitted the second time without scheduling twice', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem, store } = fixtures;

    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    const first = await evolutionSystem.notifyContractCompleted(contractId, ctx);
    expect(first.status).toBe('submitted');
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);

    const second = await evolutionSystem.notifyContractCompleted(contractId, ctx);
    expect(second.status).toBe('already_submitted');
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);
  });

  describe('notifyContractCompleted disk-state mapping', () => {
    it('submitted is returned directly', async () => {
      fixtures = await setupFixtures();
      const { contractId, ctx, evolutionSystem, store } = fixtures;

      await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

      const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);
      expect(result.status).toBe('submitted');
      expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);
    });

    it('already_submitted is returned directly', async () => {
      fixtures = await setupFixtures();
      const { contractId, ctx, evolutionSystem, store } = fixtures;

      await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });
      await evolutionSystem.notifyContractCompleted(contractId, ctx);

      const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);
      expect(result.status).toBe('already_submitted');
    });

    it('missing work item is returned directly', async () => {
      fixtures = await setupFixtures();
      const { contractId, ctx, evolutionSystem } = fixtures;

      const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);
      expect(result.status).toBe('missing_work_item');
    });
  });

  describe('retroSubagentTimeoutMs payload passthrough', () => {
    it('default 600000ms when undefined', async () => {
      fixtures = await setupFixtures();
      const { contractId, ctx, evolutionSystem, store } = fixtures;

      await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });
      await evolutionSystem.notifyContractCompleted(contractId, ctx);

      const prepared = mockSchedulePrepared.mock.calls[0][1];
      expect(prepared.payload.timeoutMs).toBe(RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT);
    });

    it('override value is passed through', async () => {
      fixtures = await setupFixtures({ retroSubagentTimeoutMs: 300000 });
      const { contractId, ctx, evolutionSystem, store } = fixtures;

      await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });
      await evolutionSystem.notifyContractCompleted(contractId, ctx);

      const prepared = mockSchedulePrepared.mock.calls[0][1];
      expect(prepared.payload.timeoutMs).toBe(300000);
    });
  });
});
