import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { ContractSystem } from '../../src/core/contract/manager.js';
import { EvolutionSystem } from '../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

// ============================================================================
// Mock: SkillSystem
// ============================================================================
const { mockSkillRegistryLoadAll, mockSkillRegistryFormatForContext } = vi.hoisted(() => ({
  mockSkillRegistryLoadAll: vi.fn().mockResolvedValue(undefined),
  mockSkillRegistryFormatForContext: vi.fn().mockReturnValue('No skills loaded'),
}));

vi.mock('../../src/foundation/skill-system/registry.js', () => ({
  SkillSystem: vi.fn().mockImplementation(() => ({
    loadAll: mockSkillRegistryLoadAll,
    formatForContext: mockSkillRegistryFormatForContext,
  })),
}));

// ============================================================================
// Mock: taskSystem.schedule
// ============================================================================
const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn().mockResolvedValue('mock-task-id'),
}));

// ============================================================================
// Helpers
// ============================================================================
interface TestFixtures {
  motionDir: string;
  clawsBaseDir: string;
  targetClawDir: string;
  contractId: string;
  ctx: MotionReviewContext;
  evolutionSystem: EvolutionSystem;
  mockAudit: { write: ReturnType<typeof vi.fn> };
}

async function setupFixtures(): Promise<TestFixtures> {
  const tmpBase = path.join(os.tmpdir(), `phase566-${randomUUID()}`);
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
  const motionAudit = new AuditWriter(motionFs, 'audit.tsv');
  const mockAudit = { write: vi.fn() };
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedule: mockSchedule } as any,
    contractManager: {} as any,
  });
  const ctx: MotionReviewContext = {
    motionFs,
    motionBaseDir: motionDir,
    motionAudit,
    clawsBaseDir,
    clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
    clawContractManagerFactory: (clawDir, targetClaw, fs) => new ContractSystem({
      clawDir,
      clawId: targetClaw,
      fs,
      audit: { write: vi.fn() } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir })
    }),
  };

  return { motionDir, clawsBaseDir, targetClawDir, contractId, ctx, evolutionSystem, mockAudit };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
}

// ============================================================================
// Tests: lazy load atomicity (phase 566 Step B α)
// ============================================================================
describe('EvolutionSystem - lazy load atomicity', () => {
  let fixtures: TestFixtures;

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (fixtures?.motionDir) {
      await cleanupFixtures(path.dirname(fixtures.motionDir));
    }
    vi.restoreAllMocks();
  });

  it('concurrent runRetroForContract triggers _loadState once', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem } = fixtures;

    const _loadStateSpy = vi.spyOn(evolutionSystem as any, '_loadState');

    // 用同一 contractId 会导致第二个 skipped_duplicate，
    // 但 _loadState 仍应在 Step 0 被触发；为更真实，用两个不同 contract
    const contractId2 = 'c2-' + randomUUID();
    const byContractPath2 = path.join(
      fixtures.motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId2}.json`
    );
    await fs.writeFile(byContractPath2, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));
    const contractDir2 = path.join(fixtures.targetClawDir, 'contract', 'active', contractId2);
    await fs.mkdir(contractDir2, { recursive: true });
    const contractYamlPath2 = path.join(contractDir2, 'contract.yaml');
    await fs.writeFile(contractYamlPath2, 'contract_id: ' + contractId2 + '\nintent: test');
    const progressPath2 = path.join(contractDir2, 'progress.json');
    await fs.writeFile(progressPath2, JSON.stringify({ contractId: contractId2, state: 'active' }));

    const [r1, r2] = await Promise.all([
      evolutionSystem.runRetroForContract(contractId, ctx),
      evolutionSystem.runRetroForContract(contractId2, ctx),
    ]);

    expect(_loadStateSpy).toHaveBeenCalledTimes(1);
    expect([r1.status, r2.status]).toContain('finished');
  });

  it('already loaded then runRetroForContract skips promise cache path', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem } = fixtures;

    // 第一次调用，完成 lazy load
    await evolutionSystem.runRetroForContract(contractId, ctx);

    const _loadStateSpy = vi.spyOn(evolutionSystem as any, '_loadState');

    // 恢复 by-contract 索引
    const byContractPath = path.join(
      fixtures.motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('skipped_duplicate');
    expect(_loadStateSpy).not.toHaveBeenCalled();
  });
});
