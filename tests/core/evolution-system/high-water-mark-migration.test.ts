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
import { makeContractId } from '../../../src/core/contract/types.js';
import { listPendingRetrospectives, ackPendingRetrospective } from '../../../src/core/summon-system/index.js';

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
  const tmpBase = path.join(os.tmpdir(), `phase1206-migration-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const contractId = makeContractId('c-' + randomUUID());

  // Create legacy pending-retrospective directory.
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });

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
    listLegacyPendingRetrospectives: () => listPendingRetrospectives({ fs: motionFs }),
    ackLegacyPendingRetrospective: (id) => ackPendingRetrospective({ fs: motionFs, contractId: id }),
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

describe('EvolutionSystem legacy pending-retrospective migration', () => {
  let fixtures: TestFixtures;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSchedulePrepared.mockResolvedValue({ taskId: 'mock-task-id', disposition: 'created' });
  });

  afterEach(async () => {
    auditSpy?.mockRestore();
    if (fixtures?.tmpBase) {
      await cleanupFixtures(fixtures.tmpBase);
    }
  });

  it('recoverRetrospectives migrates legacy by-contract rows into the new ready store', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { motionDir, motionFs, contractId, ctx, evolutionSystem } = fixtures;

    const legacyRelPath = `clawspace/pending-retrospective/by-contract/${contractId}.json`;
    const legacyPath = path.join(motionDir, legacyRelPath);
    await fs.writeFile(legacyPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    // Make the contract appear not completed so the migrated row stays in ready.
    ctx.clawContractManagerFactory = vi.fn().mockReturnValue({
      readContractYamlRaw: vi.fn().mockResolvedValue(`contract_id: ${contractId}\nintent: test`),
      getProgress: vi.fn().mockResolvedValue({ completed_at: undefined }),
    });

    const result = await evolutionSystem.recoverRetrospectives(ctx);

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);

    // Legacy row was acked (deleted).
    expect(await motionFs.exists(legacyRelPath)).toBe(false);

    // New ready row exists.
    expect(await motionFs.exists(`${READY_DIR}/${contractId}.json`)).toBe(true);

    const summaryCall = auditSpy.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.RETRO_LEGACY_MIGRATION_SUMMARY,
    );
    expect(summaryCall).toBeDefined();
  });

  it('a migrated ready row is driven to submitted when its contract is completed', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { motionDir, motionFs, contractId, ctx, evolutionSystem } = fixtures;

    const legacyRelPath = `clawspace/pending-retrospective/by-contract/${contractId}.json`;
    const legacyPath = path.join(motionDir, legacyRelPath);
    await fs.writeFile(legacyPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    const result = await evolutionSystem.recoverRetrospectives(ctx);

    expect(result.migrated).toBe(1);
    expect(result.driven).toBe(1);
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);

    // Row ended up in submitted, not ready or dispatching.
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(await motionFs.exists(`${READY_DIR}/${contractId}.json`)).toBe(false);

    const reconcileCall = auditSpy.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
  });
});
