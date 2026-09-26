/**
 * Phase 1910 Step C: onboarding singleton creation authority 测试
 * （RACE-START-ONBOARDING-SINGLETON）。
 *
 * 覆盖：
 * - 并发双 ensureOnboardingContract → 恰好一个 created、一个 resume，同一稳定 id
 * - 已发布 onboarding 的幂等重试 → created=false
 * - claim-only 崩溃窗口（.creating 残留）→ owner recoverCreation 重建后 resume
 * - 损坏 claim → fail-closed（indeterminate），证据保留不覆盖
 * - ContractSystem.recoverCreation 单 id 语义：absent/published/recovered/failed
 *
 * Phase 1911 Step I（RACE-ONBOARDING-LEGACY-ID-MIGRATION）：唯一性裁决
 * - stable + legacy 双候选 → typed conflict，双方证据不动
 * - 损坏 legacy active → conflict fail-closed，证据字节保留
 * - legacy 未发布 `.creating` claim（title=Onboarding）→ conflict 留证
 * - 双 legacy active → conflict
 *
 * Phase 1912 Step E（RACE-ONBOARDING-CROSS-ID，业务边界用户裁决）：
 * title=Onboarding 不是全系统身份——随机 id 同名合同降级为歧义迁移候选：
 * - legacy 随机 active/archive 单候选 → conflict 停止自动采用（不再复用转 resume）
 * - 通用 create 同标题不被全局拒绝，但不得冒充 start onboarding（start 冲突）
 * - stable id 仍是 start 唯一可复用身份
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { ONBOARDING_CONTRACT_ID } from '../../src/core/contract/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { buildCreationIntent, serializeCreationIntent, CREATION_CLAIM_FILE } from '../../src/core/contract/creation.js';
import { ensureOnboardingContract } from '../../src/cli/commands/start.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('Phase 1910 Step C: onboarding singleton creation authority', () => {
  let tempDir: string;
  let motionDir: string;
  let auditWrites: string[][];

  function makeSystem(): ContractSystem {
    auditWrites = auditWrites; // shared capture
    return new ContractSystem({
      clawDir: motionDir,
      clawId: 'motion',
      fs: new NodeFileSystem({ baseDir: motionDir }),
      audit: {
        write: (...args: string[]) => { auditWrites.push(args); },
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      } as never,
      toolRegistry: createToolRegistry(),
      fsFactory,
      clawsDir: `${tempDir}/claws`,
      notifyClaw: vi.fn(),
    });
  }

  const deps = {
    fsFactory,
    rootConfig: {
      isInitialized: () => true,
      loadGlobal: () => { throw new Error('not used'); },
      saveGlobal: () => { throw new Error('not used'); },
      patchPrimary: () => { throw new Error('not used'); },
    },
  };

  const onboardingYaml = () => makeContractYaml({
    title: 'Onboarding',
    goal: 'Get to know the user.',
    verification: [],
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    motionDir = path.join(tempDir, 'motion');
    await fs.mkdir(motionDir, { recursive: true });
    auditWrites = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('并发双调用：恰好一个 winner created、一个 loser resume，同一稳定 id', async () => {
    const a = makeSystem();
    const b = makeSystem();

    const [ra, rb] = await Promise.all([
      ensureOnboardingContract(deps, { system: a }, motionDir, onboardingYaml()),
      ensureOnboardingContract(deps, { system: b }, motionDir, onboardingYaml()),
    ]);

    expect(ra.contractId).toBe(ONBOARDING_CONTRACT_ID);
    expect(rb.contractId).toBe(ONBOARDING_CONTRACT_ID);
    const createdCount = [ra, rb].filter(r => r.created).length;
    expect(createdCount).toBe(1);

    // 磁盘上恰好一个 onboarding contract，且已发布（无 .creating 残留）
    const activeEntries = await fs.readdir(path.join(motionDir, 'contract', 'active'));
    expect(activeEntries).toEqual([ONBOARDING_CONTRACT_ID]);
    await expect(
      fs.access(path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID, CREATION_CLAIM_FILE)),
    ).rejects.toThrow();
    const yaml = await fs.readFile(
      path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID, 'contract.yaml'),
      'utf-8',
    );
    expect(yaml).toContain('title: Onboarding');
  });

  it('已发布 onboarding 的重复 start：already_exists → 重读 → resume（不再创建）', async () => {
    const winner = makeSystem();
    const first = await ensureOnboardingContract(deps, { system: winner }, motionDir, onboardingYaml());
    expect(first.created).toBe(true);

    const second = await ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml());
    expect(second.created).toBe(false);
    expect(second.contractId).toBe(ONBOARDING_CONTRACT_ID);

    const activeEntries = await fs.readdir(path.join(motionDir, 'contract', 'active'));
    expect(activeEntries).toEqual([ONBOARDING_CONTRACT_ID]);
  });

  it('claim-only 崩溃窗口：recoverCreation 按 durable intent 完成 winner 提交后 resume', async () => {
    // winner 崩溃形态：.creating 已提交、contract.yaml/progress.json 未发布
    const contractRoot = path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID);
    await fs.mkdir(contractRoot, { recursive: true });
    const intent = buildCreationIntent(
      onboardingYaml(),
      ONBOARDING_CONTRACT_ID,
      new Date().toISOString(),
    );
    await fs.writeFile(path.join(contractRoot, CREATION_CLAIM_FILE), serializeCreationIntent(intent));

    const result = await ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml());
    expect(result.created).toBe(false);
    expect(result.contractId).toBe(ONBOARDING_CONTRACT_ID);

    // 恢复发布完成：claim 删除、payload 落盘
    await expect(fs.access(path.join(contractRoot, CREATION_CLAIM_FILE))).rejects.toThrow();
    const progress = JSON.parse(await fs.readFile(path.join(contractRoot, 'progress.json'), 'utf-8'));
    expect(Object.keys(progress.subtasks)).toContain('task-1');
    expect(
      auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED),
    ).toBe(true);
  }, 15_000);

  it('损坏 claim：fail-closed indeterminate，证据保留不覆盖', async () => {
    const contractRoot = path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID);
    await fs.mkdir(contractRoot, { recursive: true });
    await fs.writeFile(path.join(contractRoot, CREATION_CLAIM_FILE), 'not-json');

    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/indeterminate/);

    // 证据原样保留
    expect(await fs.readFile(path.join(contractRoot, CREATION_CLAIM_FILE), 'utf-8')).toBe('not-json');
    expect(
      auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED),
    ).toBe(true);
  }, 15_000);

  it('recoverCreation 单 id 语义：absent / published / failed', async () => {
    const system = makeSystem();
    expect(await system.recoverCreation(ONBOARDING_CONTRACT_ID)).toBe('absent');

    await system.create({ ...onboardingYaml(), id: ONBOARDING_CONTRACT_ID });
    expect(await system.recoverCreation(ONBOARDING_CONTRACT_ID)).toBe('published');
  });

  // ---- Phase 1911 Step I / 1912 Step E：legacy 随机 id 唯一性治理 ----

  async function writeLegacyActiveContract(id: string, opts?: { pending?: boolean; corruptProgress?: boolean }): Promise<string> {
    const root = path.join(motionDir, 'contract', 'active', id);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), `schema_version: 1\ntitle: Onboarding\ngoal: legacy\n`);
    if (opts?.corruptProgress) {
      await fs.writeFile(path.join(root, 'progress.json'), 'not-json{');
    } else {
      const subtasks = opts?.pending === false ? {} : { 'task-1': { status: 'pending' } };
      await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ subtasks }));
    }
    return root;
  }

  async function writeLegacyArchiveCompleted(id: string): Promise<string> {
    const root = path.join(motionDir, 'contract', 'archive', 'completed', id);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), `schema_version: 1\ntitle: Onboarding\ngoal: legacy\n`);
    await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ subtasks: {} }));
    return root;
  }

  it('legacy 随机 active in_progress 单候选：歧义迁移候选 → conflict 停止自动采用（Phase 1912 E）', async () => {
    const legacyRoot = await writeLegacyActiveContract('legacy-random-1');

    // title 是展示字段不是身份：无法区分旧版 onboarding 与用户同名普通合同
    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/identity conflict[\s\S]*ambiguous/);

    // stable id 未被创建，legacy 证据原样保留
    await expect(fs.access(path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID))).rejects.toThrow();
    expect(await fs.readFile(path.join(legacyRoot, 'contract.yaml'), 'utf-8')).toContain('goal: legacy');
  });

  it('stable + legacy 双候选：typed conflict，双方证据不动', async () => {
    const system = makeSystem();
    await system.create({ ...onboardingYaml(), id: ONBOARDING_CONTRACT_ID });
    const legacyRoot = await writeLegacyActiveContract('legacy-random-2');

    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/identity conflict/);

    // stable 合同与 legacy 目录均原样保留
    const stableYaml = await fs.readFile(
      path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID, 'contract.yaml'),
      'utf-8',
    );
    expect(stableYaml).toContain('title: Onboarding');
    expect(await fs.readFile(path.join(legacyRoot, 'contract.yaml'), 'utf-8')).toContain('goal: legacy');
  });

  it('legacy archive 完成态单候选：同样歧义 → conflict 停止自动采用（Phase 1912 E）', async () => {
    const legacyRoot = await writeLegacyArchiveCompleted('legacy-done-1');

    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/identity conflict[\s\S]*ambiguous/);

    // active 下没有新建任何合同，archive 证据原样保留
    await expect(fs.access(path.join(motionDir, 'contract', 'active'))).rejects.toThrow();
    expect(await fs.readFile(path.join(legacyRoot, 'contract.yaml'), 'utf-8')).toContain('goal: legacy');
  });

  it('通用 create 同标题不被全局拒绝，但不得冒充 start onboarding（Phase 1912 E 业务边界）', async () => {
    // 普通合同可同标题：通用 create 入口 caller-owned policy，不做全局唯一拒绝
    const system = makeSystem();
    const userContractId = await system.create(onboardingYaml()); // 随机 id、title=Onboarding
    expect(userContractId).not.toBe(ONBOARDING_CONTRACT_ID);

    // 但 start 流程不得把它误认为 onboarding 身份 → conflict fail-closed
    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/identity conflict[\s\S]*ambiguous/);

    // 用户合同原样保留，stable 未创建
    expect(await fs.readFile(
      path.join(motionDir, 'contract', 'active', userContractId, 'contract.yaml'), 'utf-8',
    )).toContain('title: Onboarding');
    await expect(fs.access(path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID))).rejects.toThrow();
  });

  it('损坏 legacy active：conflict fail-closed，证据字节保留', async () => {
    const root = await writeLegacyActiveContract('legacy-corrupt-1', { corruptProgress: true });

    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/damaged/);

    expect(await fs.readFile(path.join(root, 'progress.json'), 'utf-8')).toBe('not-json{');
    await expect(fs.access(path.join(motionDir, 'contract', 'active', ONBOARDING_CONTRACT_ID))).rejects.toThrow();
  });

  it('legacy 未发布 .creating claim（title=Onboarding）：conflict 留证', async () => {
    const root = path.join(motionDir, 'contract', 'active', 'legacy-creating-1');
    await fs.mkdir(root, { recursive: true });
    const claim = JSON.stringify({ contract_id: 'legacy-creating-1', contract: { title: 'Onboarding' } });
    await fs.writeFile(path.join(root, CREATION_CLAIM_FILE), claim);

    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/unpublished/);

    expect(await fs.readFile(path.join(root, CREATION_CLAIM_FILE), 'utf-8')).toBe(claim);
  });

  it('双 legacy active 候选：conflict，不任意选择一个', async () => {
    await writeLegacyActiveContract('legacy-dual-a');
    await writeLegacyActiveContract('legacy-dual-b');

    await expect(
      ensureOnboardingContract(deps, { system: makeSystem() }, motionDir, onboardingYaml()),
    ).rejects.toThrow(/multiple ambiguous/);

    const activeEntries = (await fs.readdir(path.join(motionDir, 'contract', 'active'))).sort();
    expect(activeEntries).toEqual(['legacy-dual-a', 'legacy-dual-b']);
  });
});
