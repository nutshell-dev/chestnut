/**
 * evolution misc invariants — updated for Phase 1206 Step C disk-state architecture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSkillLoadAll, mockSkillFormat, mockSchedule, mockSchedulePrepared, mockSkillFactory } = vi.hoisted(() => {
  const loadAll = vi.fn().mockResolvedValue(undefined);
  const format = vi.fn().mockReturnValue('No skills loaded');
  return {
    mockSkillLoadAll: loadAll,
    mockSkillFormat: format,
    mockSchedule: vi.fn().mockResolvedValue('mock-task-id'),
    mockSchedulePrepared: vi.fn().mockResolvedValue({ taskId: 'mock-task-id', disposition: 'created' }),
    mockSkillFactory: vi.fn(() => ({ loadAll, formatForContext: format })),
  };
});

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { RetrospectiveStore } from '../../../src/core/evolution-system/retrospective-store.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { scheduleRetro } from '../../../src/core/evolution-system/retro-scheduler.js';
import type { RetroConfig } from '../../../src/core/evolution-system/retro-scheduler.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_TIMEOUT_MS } from '../../../src/core/subagent/constants.js';
import { makeContractId } from '../../../src/core/contract/types.js';

async function setupFixtures(overrides?: {
  contractCompleted?: boolean;
}) {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase1206-misc-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const targetClawDir = path.join(clawsBaseDir, targetClaw);
  const contractId = makeContractId('c-' + randomUUID());

  await fs.mkdir(motionDir, { recursive: true });
  await fs.mkdir(path.join(targetClawDir, 'contract', 'active', contractId), { recursive: true });

  const contractYamlPath = path.join(targetClawDir, 'contract', 'active', contractId, 'contract.yaml');
  await fs.writeFile(contractYamlPath, 'contract_id: ' + contractId + '\nintent: test');
  const progressPath = path.join(targetClawDir, 'contract', 'active', contractId, 'progress.json');
  await fs.writeFile(
    progressPath,
    JSON.stringify({
      schema_version: 1,
      contract_id: contractId,
      status: overrides?.contractCompleted === false ? 'active' : 'completed',
      subtasks: {},
      completed_at: overrides?.contractCompleted === false ? undefined : new Date().toISOString(),
    }),
  );

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const motionAudit = { write: vi.fn() };
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

  return { motionDir, motionFs, clawsBaseDir, targetClawDir, targetClaw, contractId, motionAudit, mockAudit, evolutionSystem, store, tmpBase };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

describe('boot-reconcile', () => {
  describe('EvolutionSystem.init() boot reconcile', () => {
    let fixtures: Awaited<ReturnType<typeof setupFixtures>>;

    beforeEach(async () => {
      vi.clearAllMocks();
      mockSchedulePrepared.mockResolvedValue({ taskId: 'mock-task-id', disposition: 'created' });
    });

    afterEach(async () => {
      if (fixtures?.tmpBase) {
        await cleanupFixtures(fixtures.tmpBase);
      }
    });

    function makeCtx(fixtures: Awaited<ReturnType<typeof setupFixtures>>, overrides?: { completed?: boolean }): MotionReviewContext {
      return {
        motionFs: fixtures.motionFs,
        motionBaseDir: fixtures.motionDir,
        motionAudit: fixtures.motionAudit as any,
        clawsBaseDir: fixtures.clawsBaseDir,
        clawFsFactory: (clawDir: string) => new NodeFileSystem({ baseDir: clawDir }),
        clawContractManagerFactory: (clawDir, targetClaw, fs) => new ContractSystem({
          clawDir,
          clawId: targetClaw,
          fs,
          audit: { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
          clawsDir: '/tmp/test/claws',
          notifyClaw: vi.fn(),
        }),
      };
    }

    it('emits EVOLUTION_BOOT_RECONCILE with disk-state counters when state file exists', async () => {
      fixtures = await setupFixtures();
      const { motionDir, evolutionSystem, mockAudit, contractId, store } = fixtures;

      await fs.writeFile(
        path.join(motionDir, '.evolution-system-state.json'),
        JSON.stringify({ version: 1, lastProcessedAt: 1717000000000 }),
      );
      await store.ensure({ contractId, targetExecutorId: 'claw-a' });

      const ctx = makeCtx(fixtures);
      await evolutionSystem.init(ctx);

      const reconcileCall = mockAudit.write.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      );
      expect(reconcileCall).toBeDefined();
      expect(reconcileCall).toContainEqual('failed=0');
      expect(reconcileCall).toContainEqual('recovered=0');
      expect(reconcileCall).toContainEqual('driven=1');
    });

    it('emits EVOLUTION_BOOT_RECONCILE with zero counters when no state file and no ready rows', async () => {
      fixtures = await setupFixtures();
      const { evolutionSystem, mockAudit } = fixtures;

      const ctx = makeCtx(fixtures);
      await evolutionSystem.init(ctx);

      const reconcileCall = mockAudit.write.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      );
      expect(reconcileCall).toBeDefined();
      expect(reconcileCall).toContainEqual('failed=0');
      expect(reconcileCall).toContainEqual('recovered=0');
      expect(reconcileCall).toContainEqual('driven=0');
    });

    it('corrupt legacy state file is observed but does not break reconcile', async () => {
      fixtures = await setupFixtures();
      const { motionDir, evolutionSystem, mockAudit, contractId, store } = fixtures;

      await fs.writeFile(path.join(motionDir, '.evolution-system-state.json'), 'not-json');
      await store.ensure({ contractId, targetExecutorId: 'claw-a' });

      const ctx = makeCtx(fixtures);
      await evolutionSystem.init(ctx);

      const observedCall = mockAudit.write.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_STATE_FILE_OBSERVED,
      );
      expect(observedCall).toBeDefined();

      const reconcileCall = mockAudit.write.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      );
      expect(reconcileCall).toBeDefined();
      expect(reconcileCall).toContainEqual('driven=1');
    });
  });
});

describe('system-contract-factory', () => {
  describe('EvolutionSystem — clawContractManagerFactory injection (phase 619 caller-DIP)', () => {
    it('uses ctx.clawContractManagerFactory instead of new ContractSystem', async () => {
      const fixtures = await setupFixtures();
      const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, targetClaw, evolutionSystem, store, tmpBase } = fixtures;

      await store.ensure({ contractId, targetExecutorId: targetClaw });

      const factorySpy = vi.fn().mockImplementation((clawDir: string, targetClawName: string, fs: NodeFileSystem) => {
        return new ContractSystem({
          clawDir,
          clawId: targetClawName,
          fs,
          audit: { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
          clawsDir: '/tmp/test/claws',
          notifyClaw: vi.fn(),
        });
      });

      const ctx: MotionReviewContext = {
        motionFs,
        motionBaseDir: fixtures.motionDir,
        motionAudit: motionAudit as any,
        clawsBaseDir,
        clawFsFactory: (clawDir: string) => new NodeFileSystem({ baseDir: clawDir }),
        clawContractManagerFactory: factorySpy,
      };

      const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);

      expect(result.status).toBe('submitted');
      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith(
        path.join(clawsBaseDir, targetClaw),
        targetClaw,
        expect.any(NodeFileSystem),
      );

      await fs.rm(tmpBase, { recursive: true, force: true });
    });

    it('factory error makes notifyContractCompleted reject (not silent swallow)', async () => {
      const fixtures = await setupFixtures();
      const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, evolutionSystem, store, tmpBase } = fixtures;

      await store.ensure({ contractId, targetExecutorId: 'claw-a' });

      const factorySpy = vi.fn().mockImplementation(() => {
        throw new Error('contract-factory-fail');
      });

      const ctx: MotionReviewContext = {
        motionFs,
        motionBaseDir: fixtures.motionDir,
        motionAudit: motionAudit as any,
        clawsBaseDir,
        clawFsFactory: (clawDir: string) => new NodeFileSystem({ baseDir: clawDir }),
        clawContractManagerFactory: factorySpy,
      };

      await expect(evolutionSystem.notifyContractCompleted(contractId, ctx)).rejects.toThrow('contract-factory-fail');
      expect(factorySpy).toHaveBeenCalledTimes(1);

      await fs.rm(tmpBase, { recursive: true, force: true });
    });
  });
});

describe('system-clawfs-factory', () => {
  describe('EvolutionSystem — clawFsFactory injection path (caller DIP enforce)', () => {
    it('notifyContractCompleted uses ctx.clawFsFactory to build clawFs (no bare new L1)', async () => {
      const fixtures = await setupFixtures();
      const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, targetClaw, evolutionSystem, store, tmpBase } = fixtures;

      await store.ensure({ contractId, targetExecutorId: targetClaw });

      const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

      const ctx: MotionReviewContext = {
        motionFs,
        motionBaseDir: fixtures.motionDir,
        motionAudit: motionAudit as any,
        clawsBaseDir,
        clawFsFactory: factory,
        clawContractManagerFactory: (clawDir, targetClawName, fs) => new ContractSystem({
          clawDir,
          clawId: targetClawName,
          fs,
          audit: { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
          clawsDir: '/tmp/test/claws',
          notifyClaw: vi.fn(),
        }),
      };

      const result = await evolutionSystem.notifyContractCompleted(contractId, ctx);

      expect(result.status).toBe('submitted');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith(path.join(clawsBaseDir, targetClaw));

      await fs.rm(tmpBase, { recursive: true, force: true });
    });

    it('factory error makes notifyContractCompleted reject (not silent swallow)', async () => {
      const fixtures = await setupFixtures();
      const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, evolutionSystem, store, tmpBase } = fixtures;

      await store.ensure({ contractId, targetExecutorId: 'claw-a' });

      const factory = vi.fn().mockImplementation(() => {
        throw new Error('factory-fail');
      });

      const ctx: MotionReviewContext = {
        motionFs,
        motionBaseDir: fixtures.motionDir,
        motionAudit: motionAudit as any,
        clawsBaseDir,
        clawFsFactory: factory,
        clawContractManagerFactory: (clawDir, targetClawName, fs) => new ContractSystem({
          clawDir,
          clawId: targetClawName,
          fs,
          audit: { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
          clawsDir: '/tmp/test/claws',
          notifyClaw: vi.fn(),
        }),
      };

      await expect(evolutionSystem.notifyContractCompleted(contractId, ctx)).rejects.toThrow('factory-fail');
      expect(factory).toHaveBeenCalledTimes(1);

      await fs.rm(tmpBase, { recursive: true, force: true });
    });
  });
});

describe('retro-scheduler', () => {
  function makeConfig(overrides: Partial<RetroConfig> = {}): RetroConfig {
    return {
      targetClaw: 'claw-test',
      contractId: makeContractId('c-1'),
      contractYaml: 'yaml: true',
      motionFs: {} as unknown as FileSystem,
      motionAudit: { write: vi.fn() } as unknown as AuditLog,
      motionBaseDir: '/tmp/motion',
      audit: { write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s) } as unknown as AuditLog,
      taskSystem: { schedule: mockSchedule } as unknown as RetroConfig['taskSystem'],
      createSkillSystem: mockSkillFactory,
      ...overrides,
    };
  }

  describe('scheduleRetro (phase 990 / phase 1206)', () => {
    beforeEach(() => {
      mockSkillLoadAll.mockClear();
      mockSkillFormat.mockClear().mockReturnValue('No skills loaded');
      mockSchedule.mockClear().mockResolvedValue('mock-task-id');
    });

    it('schedules retro with default timeout when skills empty', async () => {
      const config = makeConfig();
      await scheduleRetro(config);
      expect(mockSkillLoadAll).toHaveBeenCalled();
      expect(mockSchedule).toHaveBeenCalledWith(
        'subagent',
        expect.objectContaining({
          kind: 'subagent',
          intent: expect.stringContaining('yaml: true'),
          timeoutMs: SUBAGENT_TIMEOUT_MS * 2,
          parentClawId: 'motion',
          originClawId: 'motion',
        }),
      );
    });

    it('includes skills summary when skills loaded', async () => {
      mockSkillFormat.mockReturnValue('skillA, skillB');
      const config = makeConfig();
      await scheduleRetro(config);
      expect(mockSchedule).toHaveBeenCalledWith(
        'subagent',
        expect.objectContaining({
          intent: expect.stringContaining('skillA, skillB'),
        }),
      );
    });

    it('logs skill failure and continues when loadAll throws', async () => {
      mockSkillLoadAll.mockRejectedValue(new Error('disk full'));
      const config = makeConfig();
      await scheduleRetro(config);
      expect(config.audit.write).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('disk full'),
      );
      expect(mockSchedule).toHaveBeenCalled();
    });

    it('uses custom retroSubagentTimeoutMs when provided', async () => {
      const config = makeConfig({ retroSubagentTimeoutMs: 120000 });
      await scheduleRetro(config);
      expect(mockSchedule).toHaveBeenCalledWith(
        'subagent',
        expect.objectContaining({ timeoutMs: 120000 }),
      );
    });
  });
});
