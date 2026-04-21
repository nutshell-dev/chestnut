import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { ContractManager } from '../../src/core/contract/manager.js';
import type { MotionReviewContext } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';

// ============================================================================
// Mock: SkillRegistry（D4 C 方案：窄 mock 避免建真 skills/ 目录）
// ============================================================================
const { mockSkillRegistryLoadAll, mockSkillRegistryFormatForContext } = vi.hoisted(() => ({
  mockSkillRegistryLoadAll: vi.fn().mockResolvedValue(undefined),
  mockSkillRegistryFormatForContext: vi.fn().mockReturnValue('No skills loaded'),
}));

vi.mock('../../src/core/skill/registry.js', () => ({
  SkillRegistry: vi.fn().mockImplementation(() => ({
    loadAll: mockSkillRegistryLoadAll,
    formatForContext: mockSkillRegistryFormatForContext,
  })),
}));

// ============================================================================
// Mock: writePendingSubagentTaskFile（窄 mock 避免真写 tasks/pending）
// ============================================================================
const { mockWritePending } = vi.hoisted(() => ({
  mockWritePending: vi.fn().mockResolvedValue('mock-task-id'),
}));

vi.mock('../../src/core/tools/builtins/_pending-task-writer.js', () => ({
  writePendingSubagentTaskFile: mockWritePending,
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
  manager: ContractManager;
}

async function setupFixtures(): Promise<TestFixtures> {
  const tmpBase = path.join(os.tmpdir(), `phase175-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  const clawsBaseDir = path.join(tmpBase, 'claws');
  const targetClaw = 'claw-a';
  const targetClawDir = path.join(clawsBaseDir, targetClaw);
  const contractId = 'c-' + randomUUID();

  // 创建目录结构
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'tasks', 'results'), { recursive: true });
  await fs.mkdir(path.join(targetClawDir, 'contract', 'active', contractId), { recursive: true });

  // 写 by-contract index
  const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
  await fs.writeFile(byContractPath, JSON.stringify({ targetClaw, mode: 'describing' }));

  // 写 target claw 的 contract YAML + progress.json
  const contractYamlPath = path.join(targetClawDir, 'contract', 'active', contractId, 'contract.yaml');
  await fs.writeFile(contractYamlPath, 'contract_id: ' + contractId + '\nintent: test');
  const progressPath = path.join(targetClawDir, 'contract', 'active', contractId, 'progress.json');
  await fs.writeFile(progressPath, JSON.stringify({ contractId, state: 'active' }));

  // 构造 motion 侧 ContractManager + ctx
  const motionFs = new NodeFileSystem({ baseDir: motionDir, enforcePermissions: false });
  const motionAudit = new AuditWriter(motionFs, 'audit.tsv');
  const manager = new ContractManager(motionDir, 'motion', motionFs);
  const ctx: MotionReviewContext = {
    motionFs,
    motionBaseDir: motionDir,
    motionAudit,
    clawsBaseDir,
  };

  return { motionDir, clawsBaseDir, targetClawDir, contractId, ctx, manager };
}

async function cleanupFixtures(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
}

// ============================================================================
// Tests
// ============================================================================
describe('ContractManager.handleReviewRequest - happy path', () => {
  let fixtures: TestFixtures;

  beforeEach(async () => {
    vi.clearAllMocks();
    fixtures = await setupFixtures();
  });

  afterEach(async () => {
    await cleanupFixtures(path.dirname(fixtures.motionDir));
  });

  it('happy path: all fields valid → writePending called + by-contract cleaned', async () => {
    const { contractId, ctx, manager, motionDir } = fixtures;

    await manager.handleReviewRequest(contractId, ctx);

    // writePending 被调用（含关键 payload 字段）
    expect(mockWritePending).toHaveBeenCalledWith(
      ctx.motionFs,
      ctx.motionAudit,
      expect.objectContaining({
        kind: 'subagent',
        parentClawId: 'motion',
        tools: ['read', 'write', 'skill', 'exec'],
      }),
    );

    // retroMessages 含 user role retro prompt
    const args = mockWritePending.mock.calls[0][2];
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0]).toMatchObject({ role: 'user' });
    expect(args.messages[0].content).toContain(contractId);

    // by-contract 索引被删
    const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
    await expect(fs.access(byContractPath)).rejects.toThrow();
  });
});


describe('ContractManager.handleReviewRequest - best-effort branches', () => {
  let fixtures: TestFixtures;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    fixtures = await setupFixtures();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await cleanupFixtures(path.dirname(fixtures.motionDir));
  });

  // ============================================================================
  // it 1: by-contract 无效（参数化 3 子用例）
  // ============================================================================
  it('by-contract invalid → skip with warn (3 sub-cases)', async () => {
    const { contractId, ctx, manager, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // sub-case A: 非 JSON
    await fs.writeFile(byContractPath, 'not-json{{{');
    await manager.handleReviewRequest(contractId, ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not valid JSON'),
      expect.anything(),
    );
    expect(mockWritePending).not.toHaveBeenCalled();

    // sub-case B: 格式错（非 object）
    vi.clearAllMocks();
    warnSpy.mockClear();
    await fs.writeFile(byContractPath, '"just a string"');
    await manager.handleReviewRequest(contractId, ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unexpected format'),
      expect.anything(),
    );

    // sub-case C: targetClaw 非法
    vi.clearAllMocks();
    warnSpy.mockClear();
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'INVALID_UPPERCASE' }));
    await manager.handleReviewRequest(contractId, ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid targetClaw'),
      expect.anything(),
      'INVALID_UPPERCASE',
    );
  });

  // ============================================================================
  // it 2: by-contract 非 ENOENT 读错（目录当文件读触发 EISDIR）
  // ============================================================================
  it('by-contract non-ENOENT read error → skip with warn', async () => {
    const { contractId, ctx, manager, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // 删除文件，创建同名目录 → readFile 抛 EISDIR
    await fs.rm(byContractPath);
    await fs.mkdir(byContractPath);

    await manager.handleReviewRequest(contractId, ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read by-contract index'),
      contractId,
      expect.stringContaining('EISDIR'),
    );
    expect(mockWritePending).not.toHaveBeenCalled();
  });

  // ============================================================================
  // it 3: contract YAML 读失败 → skip
  // ============================================================================
  it('contract YAML load failure → skip with warn', async () => {
    const { contractId, ctx, manager, targetClawDir } = fixtures;

    // 删除 target claw 的 contract 目录（contractId 变无效）
    await fs.rm(path.join(targetClawDir, 'contract'), { recursive: true, force: true });

    await manager.handleReviewRequest(contractId, ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load contract YAML'),
      contractId,
      expect.anything(),
    );
    expect(mockWritePending).not.toHaveBeenCalled();
  });

  // ============================================================================
  // it 4: dispatch-skills 读失败退化
  // ============================================================================
  it('dispatch-skills load failure → degrade to empty skillsSummary', async () => {
    const { contractId, ctx, manager } = fixtures;

    // mock SkillRegistry loadAll 抛错
    mockSkillRegistryLoadAll.mockRejectedValueOnce(new Error('mock skills crash'));

    await manager.handleReviewRequest(contractId, ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load dispatch-skills'),
      expect.anything(),
    );
    // writePending 仍被调（退化继续，不 skip）
    expect(mockWritePending).toHaveBeenCalled();
    // writePending 被调说明退化继续（不 skip）
    expect(mockWritePending).toHaveBeenCalled();
  });

  // ============================================================================
  // it 5: mining messages 缺失退化（ENOENT + 非 ENOENT 2 子）
  // ============================================================================
  it('mining messages missing → degrade to empty baseMessages (2 sub-cases)', async () => {
    const { contractId, ctx, manager, motionDir } = fixtures;
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
    await manager.handleReviewRequest(contractId, ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Mining task messages not found'),
      'nonexistent-task-id',
    );
    expect(mockWritePending).toHaveBeenCalled();
    const args1 = mockWritePending.mock.calls[0][2];
    // baseMessages 为空 → retroMessages 只有 1 条 user（retro prompt）
    expect(args1.messages).toHaveLength(1);

    // sub-case B: 非 ENOENT（目录当文件读触发 EISDIR）
    vi.clearAllMocks();
    warnSpy.mockClear();
    await fs.writeFile(byContractPath, JSON.stringify({
      targetClaw: 'claw-a', mode: 'mining', miningTaskId: 'mining-123',
    }));
    // 建目录结构：tasks/results/mining-123/messages.json 是一个目录
    await fs.mkdir(path.join(motionDir, 'tasks', 'results', 'mining-123', 'messages.json'), { recursive: true });

    await manager.handleReviewRequest(contractId, ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load mining task messages'),
      expect.stringContaining('EISDIR'),
    );
  });

  // ============================================================================
  // it 6: writePending 失败（不清 by-contract）+ cleanup 失败
  // ============================================================================
  it('writePending failure → keep by-contract for retry (no cleanup)', async () => {
    const { contractId, ctx, manager, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    mockWritePending.mockRejectedValueOnce(new Error('mock dispatch crash'));

    await manager.handleReviewRequest(contractId, ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('retrospective schedule failed'),
      expect.anything(),
    );
    // by-contract 未删
    await expect(fs.access(byContractPath)).resolves.toBeUndefined();
  });

  it('cleanup by-contract failure → warn but no throw', async () => {
    const { contractId, ctx, manager, motionDir } = fixtures;
    const byContractPath = path.join(
      motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`
    );

    // 在 writePending resolve 前删掉 by-contract 文件 → cleanup unlink 抛 ENOENT
    mockWritePending.mockImplementationOnce(async () => {
      await fs.rm(byContractPath);
      return 'mock-task-id';
    });

    await expect(manager.handleReviewRequest(contractId, ctx)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean by-contract'),
      expect.anything(),
    );
  });
});
