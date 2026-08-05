import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { RetrospectiveStore } from '../../../src/core/evolution-system/retrospective-store.js';
import { READY_DIR, DISPATCHING_DIR, SUBMITTED_DIR } from '../../../src/core/evolution-system/retrospective-store.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
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

async function setupFixtures(): Promise<TestFixtures> {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase1206-corrupt-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const contractId = makeContractId('c-' + randomUUID());

  await fs.mkdir(motionDir, { recursive: true });
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

describe('EvolutionSystem legacy state file observed during init', () => {
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

  it('legacy .evolution-system-state.json is observed but does not block new-store processing', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { motionDir, motionFs, contractId, ctx, evolutionSystem, store } = fixtures;

    // Pre-populate the legacy state file that is no longer authoritative.
    await fs.writeFile(
      path.join(motionDir, '.evolution-system-state.json'),
      JSON.stringify({ version: 1, lastProcessedAt: 1717000000000 }),
    );

    // Register a ready row in the new store.
    await store.register({ contractId, targetClaw: 'claw-a', mode: 'shadow' });

    // Boot reconcile observes the legacy file and then drives the ready row.
    await evolutionSystem.init(ctx);

    const observedCall = auditSpy.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_FILE_OBSERVED,
    );
    expect(observedCall).toBeDefined();
    expect(observedCall!.some((arg: unknown) => typeof arg === 'string' && arg.includes('path='))).toBe(true);

    // Processing still works from the new store: contract was driven to submitted.
    expect(await motionFs.exists(`${SUBMITTED_DIR}/${contractId}.json`)).toBe(true);
    expect(mockSchedulePrepared).toHaveBeenCalledTimes(1);
  });
});
