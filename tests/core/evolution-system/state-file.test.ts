import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { ContractSystem } from '../../../src/core/contract/manager.js';
import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT } from '../../../src/core/evolution-system/retro-scheduler.js';

// ============================================================================
// Mock: SkillSystem
// ============================================================================
const { mockSkillRegistryLoadAll, mockSkillRegistryFormatForContext, mockSkillFactory } = vi.hoisted(() => {
  const loadAll = vi.fn().mockResolvedValue(undefined);
  const format = vi.fn().mockReturnValue('No skills loaded');
  return {
    mockSkillRegistryLoadAll: loadAll,
    mockSkillRegistryFormatForContext: format,
    mockSkillFactory: vi.fn(() => ({ loadAll, formatForContext: format })),
  };
});



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

async function setupFixtures(overrides?: {
  retroSubagentTimeoutMs?: number;
  stateFileContent?: string;
}): Promise<TestFixtures> {
  const tmpBase = path.join(os.tmpdir(), `phase472-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const targetClawDir = path.join(clawsBaseDir, targetClaw);
  const contractId = 'c-' + randomUUID();

  // 创建目录结构
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });
  await fs.mkdir(path.join(targetClawDir, 'contract', 'active', contractId), { recursive: true });

  // 写 by-contract index
  const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
  await fs.writeFile(byContractPath, JSON.stringify({ targetClaw, mode: 'shadow' }));

  // 写 target claw 的 contract YAML + progress.json
  const contractYamlPath = path.join(targetClawDir, 'contract', 'active', contractId, 'contract.yaml');
  await fs.writeFile(contractYamlPath, 'contract_id: ' + contractId + '\nintent: test');
  const progressPath = path.join(targetClawDir, 'contract', 'active', contractId, 'progress.json');
  await fs.writeFile(progressPath, JSON.stringify({ schema_version: 1, contract_id: contractId, status: 'completed', subtasks: {}, completed_at: new Date().toISOString() }));

  // 可选：预写 state file
  if (overrides?.stateFileContent !== undefined) {
    await fs.writeFile(path.join(motionDir, '.evolution-system-state.json'), overrides.stateFileContent);
  }

  // 构造 motion 侧 EvolutionSystem + ctx
  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const motionAudit = new AuditWriter(motionFs, 'audit.tsv');
  const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
  const mockContractManager = {} as ContractSystem;
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedule: mockSchedule } as any,
    contractManager: mockContractManager,
    retroSubagentTimeoutMs: overrides?.retroSubagentTimeoutMs,
    createSkillSystem: mockSkillFactory as any,
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
      audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),}),
  };

  return { motionDir, clawsBaseDir, targetClawDir, contractId, ctx, evolutionSystem, mockAudit };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

// ============================================================================
// Tests
// ============================================================================
describe('EvolutionSystem state file dedupe', () => {
  let fixtures: TestFixtures;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    auditSpy?.mockRestore();
    if (fixtures?.motionDir) {
      await cleanupFixtures(path.dirname(fixtures.motionDir));
    }
  });

  it('first call: no state file → loads silent + processes contract + writes state file', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('finished');
    expect(mockSchedule).toHaveBeenCalled();

    // state file 被创建
    const statePath = path.join(motionDir, '.evolution-system-state.json');
    const stateContent = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(stateContent);
    expect(state.version).toBe(1);
    expect(typeof state.lastProcessedAt).toBe('number');
    expect(state.lastProcessedAt).toBeGreaterThan(0);
  });

  it('second call same contractId: dedupe hit + return skipped_duplicate + 0 retro scheduled', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;

    // 第一次调用
    const result1 = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result1.status).toBe('finished');
    expect(mockSchedule).toHaveBeenCalledTimes(1);

    // 恢复 by-contract 索引（模拟新事件到达）
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    // 第二次调用
    vi.clearAllMocks();
    auditSpy.mockClear();
    const result2 = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result2.status).toBe('skipped_duplicate');
    expect(result2.detail).toBe('already processed');
    expect(mockSchedule).not.toHaveBeenCalled();
    const skippedCall = auditSpy.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.SKIPPED_DUPLICATE,
    );
    expect(skippedCall).toBeDefined();
    expect(skippedCall!.some((arg: unknown) => typeof arg === 'string' && arg.includes('contractId='))).toBe(true);
  });

  it('state load JSON parse error: audits + 0 dedupe (best-effort) + processes contract', async () => {
    fixtures = await setupFixtures({ stateFileContent: 'not-valid-json{{{' });
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { contractId, ctx, evolutionSystem } = fixtures;

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('finished');
    expect(mockSchedule).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('reason='),
    );
  });

  it('state save fs error: audits STATE_SAVE_FAILED + retro already scheduled (no rollback)', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;

    // 把 state file path 变成一个目录，阻止文件写入
    const statePath = path.join(motionDir, '.evolution-system-state.json');
    await fs.writeFile(statePath, JSON.stringify({ version: 1, lastProcessedAt: 0 }));
    await fs.rm(statePath);
    await fs.mkdir(statePath);

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('finished');
    expect(mockSchedule).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.STATE_SAVE_FAILED,
      expect.stringContaining('reason='),
    );
  });

  it('retroSubagentTimeoutMs default 600000ms when undefined', async () => {
    fixtures = await setupFixtures();
    const { contractId, ctx, evolutionSystem } = fixtures;

    await evolutionSystem.runRetroForContract(contractId, ctx);

    const args = mockSchedule.mock.calls[0][1];
    expect(args.timeoutMs).toBe(RETRO_SUBAGENT_TIMEOUT_MS_DEFAULT);
  });

  it('retroSubagentTimeoutMs override value is passed through', async () => {
    fixtures = await setupFixtures({ retroSubagentTimeoutMs: 300000 });
    const { contractId, ctx, evolutionSystem } = fixtures;

    await evolutionSystem.runRetroForContract(contractId, ctx);

    const args = mockSchedule.mock.calls[0][1];
    expect(args.timeoutMs).toBe(300000);
  });
});

describe('EvolutionSystem ENOENT path', () => {
  let fixtures: TestFixtures;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    auditSpy?.mockRestore();
    if (fixtures?.motionDir) {
      await cleanupFixtures(path.dirname(fixtures.motionDir));
    }
  });

  it('by-contract ENOENT → skipped_index_missing (not skipped_duplicate)', async () => {
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;

    // 删除 by-contract 索引文件
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );
    await fs.rm(byContractPath);

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('skipped_index_missing');
    expect(result.detail).toBe('ENOENT');
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});
