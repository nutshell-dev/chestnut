import { describe, it, expect, vi } from 'vitest';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { EvolutionSystem, type MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';

// ============================================================================
// Mock: AsyncTaskSystem.schedule
// ============================================================================
const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn().mockResolvedValue('mock-task-id'),
}));

// ============================================================================
// Helpers
// ============================================================================
async function setupFixtures() {
  const tmpBase = path.join(os.tmpdir(), `phase619-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const targetClawDir = path.join(clawsBaseDir, targetClaw);
  const contractId = 'c-' + randomUUID();

  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });
  await fs.mkdir(path.join(targetClawDir, 'contract', 'active', contractId), { recursive: true });

  const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
  await fs.writeFile(byContractPath, JSON.stringify({ targetClaw, mode: 'shadow' }));

  const contractYamlPath = path.join(targetClawDir, 'contract', 'active', contractId, 'contract.yaml');
  await fs.writeFile(contractYamlPath, 'contract_id: ' + contractId + '\nintent: test');
  const progressPath = path.join(targetClawDir, 'contract', 'active', contractId, 'progress.json');
  await fs.writeFile(progressPath, JSON.stringify({ contractId, state: 'active' }));

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const motionAudit = { write: vi.fn() };
  const mockAudit = { write: vi.fn() };

  return { motionDir, clawsBaseDir, targetClawDir, contractId, motionFs, motionAudit, mockAudit, tmpBase };
}

// ============================================================================
// Tests
// ============================================================================
describe('EvolutionSystem — clawContractManagerFactory injection (phase 619 caller-DIP)', () => {
  it('uses ctx.clawContractManagerFactory instead of new ContractSystem', async () => {
    const fixtures = await setupFixtures();
    const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, tmpBase } = fixtures;

    const factorySpy = vi.fn().mockImplementation((clawDir: string, targetClaw: string, fs: NodeFileSystem) => {
      return new ContractSystem({
        clawDir,
        clawId: targetClaw,
        fs,
        audit: { write: vi.fn() } as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
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

    const evolutionSystem = new EvolutionSystem({
      fs: motionFs,
      audit: mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as any,
    });

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('finished');
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledWith(
      path.join(clawsBaseDir, 'claw-a'),
      'claw-a',
      expect.any(NodeFileSystem),
    );

    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('does not directly construct ContractSystem (factory controls instantiation)', async () => {
    const fixtures = await setupFixtures();
    const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, tmpBase } = fixtures;

    const factorySpy = vi.fn().mockImplementation((clawDir: string, targetClaw: string, fs: NodeFileSystem) => {
      return new ContractSystem({
        clawDir,
        clawId: targetClaw,
        fs,
        audit: { write: vi.fn() } as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
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

    const evolutionSystem = new EvolutionSystem({
      fs: motionFs,
      audit: mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as any,
    });

    await evolutionSystem.runRetroForContract(contractId, ctx);

    // factorySpy 被调用即证明 DIP：业务层通过 ctx factory 获取实例，而非裸 new
    expect(factorySpy).toHaveBeenCalledTimes(1);

    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('factory 抛错时 runRetroForContract 直接 reject（不 silent swallow）', async () => {
    const fixtures = await setupFixtures();
    const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, tmpBase } = fixtures;

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

    const evolutionSystem = new EvolutionSystem({
      fs: motionFs,
      audit: mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as any,
    });

    await expect(evolutionSystem.runRetroForContract(contractId, ctx)).rejects.toThrow('contract-factory-fail');
    expect(factorySpy).toHaveBeenCalledTimes(1);

    await fs.rm(tmpBase, { recursive: true, force: true });
  });
});
