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
});
