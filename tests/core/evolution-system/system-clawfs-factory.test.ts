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
  const tmpBase = path.join(os.tmpdir(), `phase609-${randomUUID()}`);
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
describe('EvolutionSystem — clawFsFactory 注入路径（caller DIP enforce）', () => {
  it('runRetroForContract 用 ctx.clawFsFactory 构 clawFs（不裸 new L1）', async () => {
    const fixtures = await setupFixtures();
    const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, tmpBase } = fixtures;

    const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

    const ctx: MotionReviewContext = {
      motionFs,
      motionBaseDir: fixtures.motionDir,
      motionAudit: motionAudit as any,
      clawsBaseDir,
      clawFsFactory: factory,
      clawContractManagerFactory: (clawDir, targetClaw, fs) => new ContractSystem({
        clawDir,
        clawId: targetClaw,
        fs,
        audit: { write: vi.fn() } as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
      }),
    };

    const evolutionSystem = new EvolutionSystem({
      fs: motionFs,
      audit: mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as any,
    });

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('finished');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(path.join(clawsBaseDir, 'claw-a'));

    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('factory 抛错时 runRetroForContract 直接 reject（不 silent swallow）', async () => {
    const fixtures = await setupFixtures();
    const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, tmpBase } = fixtures;

    const factory = vi.fn().mockImplementation(() => {
      throw new Error('factory-fail');
    });

    const ctx: MotionReviewContext = {
      motionFs,
      motionBaseDir: fixtures.motionDir,
      motionAudit: motionAudit as any,
      clawsBaseDir,
      clawFsFactory: factory,
      clawContractManagerFactory: (clawDir, targetClaw, fs) => new ContractSystem({
        clawDir,
        clawId: targetClaw,
        fs,
        audit: { write: vi.fn() } as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
      }),
    };

    const evolutionSystem = new EvolutionSystem({
      fs: motionFs,
      audit: mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as any,
    });

    await expect(evolutionSystem.runRetroForContract(contractId, ctx)).rejects.toThrow('factory-fail');
    expect(factory).toHaveBeenCalledTimes(1);

    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('多次 runRetroForContract 各自调 factory（per-call dynamic）', async () => {
    const fixtures = await setupFixtures();
    const { contractId, motionFs, motionAudit, mockAudit, clawsBaseDir, tmpBase, motionDir, targetClawDir } = fixtures;

    // 准备第二个 contract / 不同 targetClaw
    const contractId2 = 'c2-' + randomUUID();
    const targetClaw2 = 'claw-b';
    const targetClawDir2 = path.join(clawsBaseDir, targetClaw2);
    await fs.mkdir(path.join(targetClawDir2, 'contract', 'active', contractId2), { recursive: true });
    const byContractPath2 = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId2}.json`);
    await fs.writeFile(byContractPath2, JSON.stringify({ targetClaw: targetClaw2, mode: 'shadow' }));
    const contractYamlPath2 = path.join(targetClawDir2, 'contract', 'active', contractId2, 'contract.yaml');
    await fs.writeFile(contractYamlPath2, 'contract_id: ' + contractId2 + '\nintent: test');
    const progressPath2 = path.join(targetClawDir2, 'contract', 'active', contractId2, 'progress.json');
    await fs.writeFile(progressPath2, JSON.stringify({ contractId: contractId2, state: 'active' }));

    const factory = vi.fn().mockImplementation((clawDir: string) => new NodeFileSystem({ baseDir: clawDir }));

    const ctx: MotionReviewContext = {
      motionFs,
      motionBaseDir: motionDir,
      motionAudit: motionAudit as any,
      clawsBaseDir,
      clawFsFactory: factory,
      clawContractManagerFactory: (clawDir, targetClaw, fs) => new ContractSystem({
        clawDir,
        clawId: targetClaw,
        fs,
        audit: { write: vi.fn() } as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
      }),
    };

    const evolutionSystem = new EvolutionSystem({
      fs: motionFs,
      audit: mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as any,
    });

    const result1 = await evolutionSystem.runRetroForContract(contractId, ctx);
    const result2 = await evolutionSystem.runRetroForContract(contractId2, ctx);

    expect(result1.status).toBe('finished');
    expect(result2.status).toBe('finished');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(1, path.join(clawsBaseDir, 'claw-a'));
    expect(factory).toHaveBeenNthCalledWith(2, path.join(clawsBaseDir, 'claw-b'));

    await fs.rm(tmpBase, { recursive: true, force: true });
  });
});
