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
import { RETRO_AUDIT_EVENTS } from '../../src/core/evolution-system/retro-audit-events.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

// ============================================================================
// Mock: SkillSystem（D4 C 方案：窄 mock 避免建真 skills/ 目录）
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
// Mock: AsyncTaskSystem.schedule（窄 mock 避免真写 tasks/queues/pending）
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
  const tmpBase = path.join(os.tmpdir(), `phase411-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const targetClawDir = path.join(clawsBaseDir, targetClaw);
  const contractId = 'c-' + randomUUID();

  // 创建目录结构
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'tasks', 'queues', 'results'), { recursive: true });
  await fs.mkdir(path.join(targetClawDir, 'contract', 'active', contractId), { recursive: true });

  // 写 by-contract index
  const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
  await fs.writeFile(byContractPath, JSON.stringify({ targetClaw, mode: 'shadow' }));

  // 写 target claw 的 contract YAML + progress.json
  const contractYamlPath = path.join(targetClawDir, 'contract', 'active', contractId, 'contract.yaml');
  await fs.writeFile(contractYamlPath, 'contract_id: ' + contractId + '\nintent: test');
  const progressPath = path.join(targetClawDir, 'contract', 'active', contractId, 'progress.json');
  await fs.writeFile(progressPath, JSON.stringify({ contractId, state: 'active' }));

  // 构造 motion 侧 EvolutionSystem + ctx
  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const motionAudit = new AuditWriter(motionFs, 'audit.tsv');
  const mockAudit = { write: vi.fn() };
  const mockContractManager = {} as ContractSystem;
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedule: mockSchedule } as any,
    contractManager: mockContractManager,
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
// Tests
// ============================================================================
describe('EvolutionSystem.runRetroForContract - happy path', () => {
  let fixtures: TestFixtures;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fixtures = await setupFixtures();
  });

  afterEach(async () => {
    await cleanupFixtures(path.dirname(fixtures.motionDir));
  });

  it('happy path: all fields valid → writePending called + by-contract cleaned', async () => {
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);

    expect(result.status).toBe('finished');

    // writePending 被调用（含关键 payload 字段）
    expect(mockSchedule).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({
        kind: 'subagent',
        parentClawId: 'motion',
      }),
    );

    // intent 包含 contractId
    const args = mockSchedule.mock.calls[0][1];
    expect(args.intent).toContain(contractId);

    // by-contract 索引被删
    const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
    await expect(fs.access(byContractPath)).rejects.toThrow();
  });
});


describe('EvolutionSystem.runRetroForContract - best-effort branches', () => {
  let fixtures: TestFixtures;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fixtures = await setupFixtures();
    auditSpy = vi.spyOn(fixtures.mockAudit, 'write');
  });

  afterEach(async () => {
    auditSpy.mockRestore();
    await cleanupFixtures(path.dirname(fixtures.motionDir));
  });

  // ============================================================================
  // it 1: by-contract 无效（参数化 3 子用例）
  // ============================================================================
  it('by-contract invalid → skip with warn (3 sub-cases)', async () => {
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // sub-case A: 非 JSON
    await fs.writeFile(byContractPath, 'not-json{{{');
    let result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('error');
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.INDEX_FAILED,
      expect.stringContaining('contractId='),
      'reason=invalid_json',
    );
    expect(mockSchedule).not.toHaveBeenCalled();

    // sub-case B: 格式错（非 object）
    vi.clearAllMocks();
    auditSpy.mockClear();
    await fs.writeFile(byContractPath, '"just a string"');
    result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('error');
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.INDEX_FAILED,
      expect.stringContaining('contractId='),
      'reason=unexpected_format',
    );

    // sub-case C: targetClaw 非法
    vi.clearAllMocks();
    auditSpy.mockClear();
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'INVALID_UPPERCASE' }));
    result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('error');
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.INDEX_FAILED,
      expect.stringContaining('contractId='),
      'reason=invalid_targetClaw',
      expect.stringContaining('rawTarget='),
    );
  });

  // ============================================================================
  // it 2: by-contract 非 ENOENT 读错（目录当文件读触发 EISDIR）
  // ============================================================================
  it('by-contract non-ENOENT read error → skip with warn', async () => {
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // 删除文件，创建同名目录 → readFile 抛 EISDIR
    await fs.rm(byContractPath);
    await fs.mkdir(byContractPath);

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('error');

    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.INDEX_FAILED,
      expect.stringContaining('contractId='),
      expect.stringContaining('error='),
    );
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  // ============================================================================
  // it 3: contract YAML 读失败 → skip
  // ============================================================================
  it('contract YAML load failure → skip with warn', async () => {
    const { contractId, ctx, evolutionSystem, targetClawDir } = fixtures;

    // 删除 target claw 的 contract 目录（contractId 变无效）
    await fs.rm(path.join(targetClawDir, 'contract'), { recursive: true, force: true });

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('error');

    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.YAML_FAILED,
      expect.stringContaining('contractId='),
      expect.stringContaining('error='),
    );
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  // ============================================================================
  // it 4: dispatch-skills 读失败退化
  // ============================================================================
  it('dispatch-skills load failure → degrade to empty skillsSummary', async () => {
    const { contractId, ctx, evolutionSystem } = fixtures;

    // mock SkillSystem loadAll 抛错
    mockSkillRegistryLoadAll.mockRejectedValueOnce(new Error('mock skills crash'));

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('finished');

    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.SKILL_FAILED,
      expect.stringContaining('error='),
    );
    // writePending 仍被调（退化继续，不 skip）
    expect(mockSchedule).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({
        kind: 'subagent',
        parentClawId: 'motion',
      }),
    );
  });

  // ============================================================================
  // it 5: mining messages 缺失退化（ENOENT + 非 ENOENT 2 子）
  // ============================================================================
  it('mining messages missing → degrade to empty baseMessages (2 sub-cases)', async () => {
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // 改 by-contract 为 mining 模式（miningTaskId 指向不存在目录）
    await fs.writeFile(byContractPath, JSON.stringify({
      targetClaw: 'claw-a',
      mode: 'mining',
      miningTaskId: 'nonexistent-task-id',
    }));

    // sub-case A: ENOENT
    let result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('finished');
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.MINING_FAILED,
      expect.stringContaining('taskId='),
      'reason=ENOENT',
    );
    expect(mockSchedule).toHaveBeenCalledWith(
      'subagent',
      expect.objectContaining({
        kind: 'subagent',
        parentClawId: 'motion',
      }),
    );

    // sub-case B: 非 ENOENT（目录当文件读触发 EISDIR）
    vi.clearAllMocks();
    auditSpy.mockClear();
    // 删除 state file 避免 dedupe（sub-case A 已持久化该 contractId）
    const stateFilePath = path.join(motionDir, '.evolution-system-state.json');
    await fs.rm(stateFilePath, { force: true });
    // 新建 EvolutionSystem 实例以重置内存 dedupe state
    const freshEvolutionSystem = new EvolutionSystem({
      fs: ctx.motionFs,
      audit: fixtures.mockAudit as any,
      taskSystem: { schedule: mockSchedule } as any,
      contractManager: {} as ContractSystem,
    });
    await fs.writeFile(byContractPath, JSON.stringify({
      targetClaw: 'claw-a', mode: 'mining', miningTaskId: 'mining-123',
    }));
    // 建目录结构：tasks/queues/results/mining-123/messages.json 是一个目录
    await fs.mkdir(path.join(motionDir, 'tasks', 'queues', 'results', 'mining-123', 'messages.json'), { recursive: true });

    result = await freshEvolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('finished');
    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.MINING_FAILED,
      expect.stringContaining('taskId='),
      expect.stringContaining('error='),
    );
  });

  // ============================================================================
  // it 6: writePending 失败（不清 by-contract）+ cleanup 失败
  // ============================================================================
  it('writePending failure → keep by-contract for retry (no cleanup)', async () => {
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    mockSchedule.mockRejectedValueOnce(new Error('mock dispatch crash'));

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('error');

    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.SCHEDULE_FAILED,
      expect.stringContaining('error='),
    );
    // by-contract 未删
    await expect(fs.access(byContractPath)).resolves.toBeUndefined();
  });

  it('cleanup by-contract failure → warn but no throw', async () => {
    const { contractId, ctx, evolutionSystem, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // 在 writePending resolve 前删掉 by-contract 文件 → cleanup unlink 抛 ENOENT
    mockSchedule.mockImplementationOnce(async () => {
      await fs.rm(byContractPath);
      return 'mock-task-id';
    });

    const result = await evolutionSystem.runRetroForContract(contractId, ctx);
    expect(result.status).toBe('finished');

    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.CLEANUP_FAILED,
      expect.stringContaining('error='),
    );
  });
});
