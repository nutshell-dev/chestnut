/**
 * evolution misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - retro-chain-stall.test.ts
 *  - boot-reconcile.test.ts
 *  - system-contract-factory.test.ts
 *  - system-clawfs-factory.test.ts
 *  - retro-scheduler.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSkillLoadAll, mockSkillFormat, mockSchedule, mockSkillFactory } = vi.hoisted(() => {
  const loadAll = vi.fn().mockResolvedValue(undefined);
  const format = vi.fn().mockReturnValue('No skills loaded');
  return {
    mockSkillLoadAll: loadAll,
    mockSkillFormat: format,
    mockSchedule: vi.fn().mockResolvedValue('mock-task-id'),
    mockSkillFactory: vi.fn(() => ({ loadAll, formatForContext: format })),
  };
});
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import type { MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import type { ContractId } from '../../../src/foundation/branded/contract-id.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { randomUUID } from 'crypto';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { scheduleRetro } from '../../../src/core/evolution-system/retro-scheduler.js';
import type { RetroConfig } from '../../../src/core/evolution-system/retro-scheduler.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_TIMEOUT_MS } from '../../../src/core/subagent/constants.js';

describe('retro-chain-stall', () => {
  /**
   * Phase 450 (review-round3 §3): retroChain wait prev 超时反向测试。
   *
   * 验证：
   * - 正常 chain 串行（无 stall、无 STALLED audit）
   * - prev 永不 resolve → 超时后本次进 impl + emit RETRO_CHAIN_STALLED audit
   */

  const RETRO_CHAIN_STALL_TIMEOUT_MS = 10 * 60 * 1000;

  describe('retroChain stall timeout (phase 450 review)', () => {
    let testDir: string;
    let clawDir: string;
    let auditWrite: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      testDir = path.join(
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        os.tmpdir(),
        `.test-retro-chain-stall-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
      );
      clawDir = path.join(testDir, 'motion');
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      await fs.mkdir(clawDir, { recursive: true });
      auditWrite = vi.fn();
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function makeSystem(): EvolutionSystem {
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      return new EvolutionSystem({
        fs: nodeFs,
        audit: { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as never,
        taskSystem: {} as never,
        contractManager: {} as never,
      });
    }

    it('正常 chain 串行 — 无 STALLED audit', async () => {
      const sys = makeSystem();
      // 替换 _runRetroForContractImpl 为快速返回 mock
      const impl = vi.fn().mockResolvedValue({ status: 'finished' } as never);
      (sys as unknown as { _runRetroForContractImpl: typeof impl })._runRetroForContractImpl = impl;

      const r1 = await sys.runRetroForContract('c-1' as ContractId, {} as never);
      const r2 = await sys.runRetroForContract('c-2' as ContractId, {} as never);

      expect(r1.status).toBe('finished');
      expect(r2.status).toBe('finished');
      expect(impl).toHaveBeenCalledTimes(2);

      const stallCalls = auditWrite.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.RETRO_CHAIN_STALLED);
      expect(stallCalls).toHaveLength(0);
    });

    it('prev 永不 resolve → 超时后返回 blocked + emit RETRO_CHAIN_STALLED，不进入 impl', async () => {
      vi.useFakeTimers();
      const sys = makeSystem();

      // 第一次 impl 永不 resolve
      let resolveFirst: (() => void) | null = null;
      const neverPromise = new Promise<{ status: 'finished' }>(res => {
        resolveFirst = () => res({ status: 'finished' });
      });
      const impl = vi.fn()
        .mockImplementationOnce(() => neverPromise)
        .mockResolvedValueOnce({ status: 'finished' } as never);
      (sys as unknown as { _runRetroForContractImpl: typeof impl })._runRetroForContractImpl = impl;

      // 第一次 runRetroForContract — 不 await（卡在 impl）
      void sys.runRetroForContract('c-1' as ContractId, {} as never);
      // 推时间让 microtask flush
      await Promise.resolve();

      // 第二次 runRetroForContract — 应等 prev、但 prev 永不 resolve → 等 stall timeout
      const p2 = sys.runRetroForContract('c-2' as ContractId, {} as never);

      // 推进 stall timeout
      await vi.advanceTimersByTimeAsync(RETRO_CHAIN_STALL_TIMEOUT_MS + 100);

      const r2 = await p2;
      expect(r2.status).toBe('blocked');
      expect(r2.reason).toBe('previous_retro_stalled');
      expect(impl).toHaveBeenCalledTimes(1);  // 第二次 impl 没有跑

      const stallCalls = auditWrite.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.RETRO_CHAIN_STALLED);
      expect(stallCalls).toHaveLength(1);
      expect(stallCalls[0]).toContainEqual('contract_id=c-2');
      expect(stallCalls[0]).toContainEqual(`timeout_ms=${RETRO_CHAIN_STALL_TIMEOUT_MS}`);

      // cleanup: 解锁第一个 retro
      resolveFirst?.();
    });

    it('phase 1078: stall 标志持续阻塞后续请求，直到原 prev 真实 settle', async () => {
      vi.useFakeTimers();
      const sys = makeSystem();

      let resolveFirst: (() => void) | null = null;
      const neverPromise = new Promise<{ status: 'finished' }>(res => {
        resolveFirst = () => res({ status: 'finished' });
      });
      const impl = vi.fn()
        .mockImplementationOnce(() => neverPromise)
        .mockResolvedValue({ status: 'finished' } as never);
      (sys as unknown as { _runRetroForContractImpl: typeof impl })._runRetroForContractImpl = impl;

      // A: 卡住
      const pA = sys.runRetroForContract('c-1' as ContractId, {} as never);
      await Promise.resolve();

      // B: 检测到 stall，返回 blocked
      const pB = sys.runRetroForContract('c-2' as ContractId, {} as never);
      await vi.advanceTimersByTimeAsync(RETRO_CHAIN_STALL_TIMEOUT_MS + 100);
      const rB = await pB;
      expect(rB.status).toBe('blocked');
      expect(rB.reason).toBe('previous_retro_stalled');

      // C: 在 A 未 settle 前到达，应被标志立即阻塞，不进入 impl，也不产生新 STALLED audit
      const pC = sys.runRetroForContract('c-3' as ContractId, {} as never);
      const rC = await pC;
      expect(rC.status).toBe('blocked');
      expect(rC.reason).toBe('previous_retro_stalled');
      expect(impl).toHaveBeenCalledTimes(1); // 只有 A 调用了 impl

      const stallCallsAfterC = auditWrite.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.RETRO_CHAIN_STALLED);
      expect(stallCallsAfterC).toHaveLength(1); // C 不产生额外 audit

      // A 真实 settle；等待 pA 完成以触发 prev.finally() 清除 blocked 标志
      resolveFirst?.();
      await pA;

      // D: 原 prev 已 settle，应恢复执行
      const rD = await sys.runRetroForContract('c-4' as ContractId, {} as never);
      expect(rD.status).toBe('finished');
      expect(impl).toHaveBeenCalledTimes(2); // A + D
    });
  });
});

describe('boot-reconcile', () => {
  /**
   * @module tests/core/evolution-system/boot-reconcile
   * Phase 1335 sub-2: EvolutionSystem.init() eager boot reconcile reverse test
   */

  describe('EvolutionSystem.init() boot reconcile', () => {
    let testDir: string;
    let clawDir: string;
    let auditWrite: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      testDir = path.join(
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        os.tmpdir(),
        `.test-evolution-boot-reconcile-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
      );
      clawDir = path.join(testDir, 'motion');
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      await fs.mkdir(clawDir, { recursive: true });
      auditWrite = vi.fn();
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
      vi.restoreAllMocks();
    });

    function makeSystem() {
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      return new EvolutionSystem({
        fs: nodeFs,
        audit: { write: auditWrite , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
        taskSystem: {} as any,
        contractManager: {} as any,
      });
    }

    it('emits EVOLUTION_BOOT_RECONCILE + loads lastProcessedAt when state file exists', async () => {
      await fs.writeFile(
        path.join(clawDir, '.evolution-system-state.json'),
        JSON.stringify({
          version: 1,
          lastProcessedAt: 1717000000000,
        }),
      );

      const sys = makeSystem();
      await sys.init();

      const reconcileCall = auditWrite.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      );
      expect(reconcileCall).toBeDefined();
      expect(reconcileCall).toContainEqual('last_processed_at=1717000000000');
      expect(reconcileCall).toContainEqual('high_water_mark_mode=true');
    });

    it('emits EVOLUTION_BOOT_RECONCILE high_water_mark_mode when no state file', async () => {
      const sys = makeSystem();
      await sys.init();

      const reconcileCall = auditWrite.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      );
      expect(reconcileCall).toBeDefined();
      expect(reconcileCall).toContainEqual('last_processed_at=0');
      expect(reconcileCall).toContainEqual('high_water_mark_mode=true');
    });

    it('corrupt state file triggers backup path + audit emit', async () => {
      await fs.writeFile(
        path.join(clawDir, '.evolution-system-state.json'),
        'not-json',
      );

      const sys = makeSystem();
      await sys.init();

      const loadFailedCall = auditWrite.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
      );
      expect(loadFailedCall).toBeDefined();

      const reconcileCall = auditWrite.mock.calls.find(
        (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
      );
      expect(reconcileCall).toBeDefined();
      expect(reconcileCall).toContainEqual('last_processed_at=0');
    });
  });
});

describe('system-contract-factory', () => {
  // ============================================================================
  // Helpers
  // ============================================================================
  async function setupFixtures() {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
    await fs.writeFile(progressPath, JSON.stringify({ schema_version: 1, contract_id: contractId, status: 'active', subtasks: {}, completed_at: new Date().toISOString() }));

    const motionFs = new NodeFileSystem({ baseDir: motionDir });
    const motionAudit = { write: vi.fn() };
    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};

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
          audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
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
          audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),});
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
});

describe('system-clawfs-factory', () => {
  // ============================================================================
  // Helpers
  // ============================================================================
  async function setupFixtures() {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
    await fs.writeFile(progressPath, JSON.stringify({ schema_version: 1, contract_id: contractId, status: 'active', subtasks: {}, completed_at: new Date().toISOString() }));

    const motionFs = new NodeFileSystem({ baseDir: motionDir });
    const motionAudit = { write: vi.fn() };
    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};

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
          audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),}),
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
          audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),}),
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
      await fs.writeFile(progressPath2, JSON.stringify({ schema_version: 1, contract_id: contractId2, status: 'active', subtasks: {}, completed_at: new Date().toISOString() }));

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
          audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as any,
          toolRegistry: createToolRegistry(),
          fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),}),
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
});

describe('retro-scheduler', () => {
  /**
   * retro-scheduler unit tests (phase 990 / r121 F fork)
   *
   * Tests scheduleRetro paths via mocked skill-system + prompt builder + pending writer.
   */

  function makeConfig(overrides: Partial<RetroConfig> = {}): RetroConfig {
    return {
      targetClaw: 'claw-test',
      contractId: 'c-1',
      contractYaml: 'yaml: true',
      motionFs: {} as unknown as FileSystem,
      motionAudit: { write: vi.fn() } as unknown as AuditLog,
      motionBaseDir: '/tmp/motion',
      baseMessages: [{ role: 'user', content: 'hi' }],
      audit: { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)} as unknown as AuditLog,
      taskSystem: { schedule: mockSchedule } as unknown as RetroConfig['taskSystem'],
      createSkillSystem: mockSkillFactory,
      ...overrides,
    };
  }

  describe('scheduleRetro (phase 990)', () => {
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
          timeoutMs: SUBAGENT_TIMEOUT_MS * 2,  // phase 1159: retro 任务 = 2 × subagent default timeout
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
