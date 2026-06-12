/**
 * Phase 233 Step A: contract progress shape invariants
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { assertProgressShapeInvariants } from '../../../src/core/contract/invariants.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';

function makeProgress(overrides: Record<string, unknown> = {}): Parameters<typeof assertProgressShapeInvariants>[0] {
  return {
    schema_version: 1,
    contract_id: 'test-contract',
    status: 'running',
    subtasks: {
      t1: { status: 'todo' },
    },
    ...overrides,
  } as any;
}

describe('contract progress shape invariants (phase 233 Step A)', () => {
  describe('sub-check 1: schema_version', () => {
    it('schema_version=1 (current) 0 emit', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ schema_version: 1 }), audit, 'saveProgress');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('schema_version=undefined 0 emit (legacy 兼容)', () => {
      const audit = makeMockAudit();
      const p = makeProgress();
      delete (p as any).schema_version;
      assertProgressShapeInvariants(p, audit, 'saveProgress');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('schema_version=99 → emit kind=schema_version_invalid', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ schema_version: 99 }), audit, 'saveProgress');
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED);
      expect(call).toContainEqual(expect.stringContaining('kind=schema_version_invalid'));
      expect(call).toContainEqual(expect.stringContaining('actual=99'));
      expect(call).toContainEqual(expect.stringContaining('source=saveProgress'));
    });

    it('schema_version="1" 字符串 → emit kind=schema_version_invalid', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ schema_version: '1' }), audit, 'saveProgress');
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call).toContainEqual(expect.stringContaining('kind=schema_version_invalid'));
    });
  });

  describe('sub-check 2: contract_id (phase 282 Step B)', () => {
    it('contract_id 已改为 derive from caller/dir，invariants 不再检查 contract_id', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ contract_id: '' }), audit, 'saveProgress');
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('sub-check 3: ContractStatus union (phase 282 Step A)', () => {
    it('status 已改为 derive from subtasks，invariants 不再检查 status union', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ status: 'invalid_state' }), audit, 'saveProgress');
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('sub-check 4: subtasks shape', () => {
    it('正常 subtasks 0 emit', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({
        subtasks: { t1: { status: 'todo' }, t2: { status: 'completed', completed_at: '2024-01-01' } },
      }), audit, 'saveProgress');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('subtasks=null → emit kind=subtasks_not_object', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ subtasks: null }), audit, 'saveProgress');
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED);
      expect(call).toContainEqual(expect.stringContaining('kind=subtasks_not_object'));
    });

    it('subtask.status="invalid" → emit kind=subtask_status_not_in_union', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({
        subtasks: { t1: { status: 'invalid' } },
      }), audit, 'saveProgress');
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED);
      expect(call).toContainEqual(expect.stringContaining('kind=subtask_status_not_in_union'));
      expect(call).toContainEqual(expect.stringContaining('subtask_id=t1'));
      expect(call).toContainEqual(expect.stringContaining('actual=invalid'));
    });

    it('subtask=null → emit kind=subtask_not_object', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({
        subtasks: { t1: null },
      }), audit, 'saveProgress');
      expect(audit.write).toHaveBeenCalledTimes(1);
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED);
      expect(call).toContainEqual(expect.stringContaining('kind=subtask_not_object'));
      expect(call).toContainEqual(expect.stringContaining('subtask_id=t1'));
    });
  });

  describe('source 字段', () => {
    it('saveProgress 调用源 = "saveProgress"', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ schema_version: 99 }), audit, 'saveProgress');
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call).toContainEqual(expect.stringContaining('source=saveProgress'));
    });

    it('boot_reconcile_escalated 源', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ schema_version: 99 }), audit, 'boot_reconcile_escalated');
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call).toContainEqual(expect.stringContaining('source=boot_reconcile_escalated'));
    });

    it('boot_reconcile_all_completed 源', () => {
      const audit = makeMockAudit();
      assertProgressShapeInvariants(makeProgress({ schema_version: 99 }), audit, 'boot_reconcile_all_completed');
      const call = (audit.write as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call).toContainEqual(expect.stringContaining('source=boot_reconcile_all_completed'));
    });
  });

  describe('saveProgress 集成', () => {
    let tmpDir: string;
    let clawDir: string;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), `.test-phase233-a-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
      clawDir = path.join(tmpDir, 'claws', 'test-claw');
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(clawDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('合法 progress 写入 → 文件落盘 + 0 audit emit', async () => {
      const mockAudit = makeMockAudit();
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      const manager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        clawsDir: '/tmp/test/claws',
        notifyClaw: vi.fn(),
      });

      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
      const content = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      // phase 282 Step B: contract_id is derive field, not persisted
      expect(content).not.toHaveProperty('contract_id');
      expect(content.schema_version).toBe(1);
      expect(content.subtasks).toBeDefined();

      const badCalls = (mockAudit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      );
      expect(badCalls).toHaveLength(0);
    });

    it('非法 progress 写入 → 文件仍落盘（不 throw）+ audit emit (phase 282 Step A)', async () => {
      const mockAudit = makeMockAudit();
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      const manager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        clawsDir: '/tmp/test/claws',
        notifyClaw: vi.fn(),
      });

      const contractId = await manager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      // 直接 overwrite progress.json 为非法 subtask status
      const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
      await fs.writeFile(progressPath, JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        status: 'running',
        subtasks: { t1: { status: 'invalid_status' } },
      }), 'utf-8');

      // 通过 getProgress 读取后再 saveProgress 应该 emit audit 但不 throw
      const progress = await manager.getProgress(contractId);
      expect(progress).not.toBeNull();
      await manager.saveProgress(contractId, progress as any);

      const badCalls = (mockAudit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      );
      expect(badCalls.length).toBeGreaterThanOrEqual(1);
      expect(badCalls.some((c: any[]) => c.some((s: string) => s.includes('kind=subtask_status_not_in_union')))).toBe(true);

      // 文件仍然落盘
      const saved = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      expect(saved.subtasks.t1.status).toBe('invalid_status');
    });
  });

  describe('boot reconcile inline 路径', () => {
    let testDir: string;
    let clawDir: string;

    beforeEach(async () => {
      testDir = path.join(os.tmpdir(), `.test-phase233-boot-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
      clawDir = path.join(testDir, 'claws', 'test-claw');
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(clawDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it('escalated migrate 路径调 invariants', async () => {
      const auditWrite = vi.fn();
      const nodeFs = new NodeFileSystem({ baseDir: clawDir });
      const manager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any,
        toolRegistry: createToolRegistry(),
        fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        clawsDir: '/tmp/test/claws',
        notifyClaw: vi.fn(),
      });

      const activeDir = path.join(clawDir, 'contract', 'active', 'boot-contract');
      await fs.mkdir(activeDir, { recursive: true });
      await fs.writeFile(
        path.join(activeDir, 'progress.json'),
        JSON.stringify({
          schema_version: 1,
          contract_id: 'boot-contract',
          status: 'running',
          subtasks: { t1: { status: 'escalated', escalated_at: '2024-01-01' } },
        }),
      );
      await fs.writeFile(
        path.join(activeDir, 'contract.yaml'),
        'schema_version: 1\nid: boot-contract\ntitle: T\ngoal: G\nsubtasks:\n  - id: t1\n    description: D\n',
      );

      await manager.init();

      // 应该触发 boot_reconcile_escalated 和 boot_reconcile_all_completed 两个 source 的 invariant
      const invariantCalls = auditWrite.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_PROGRESS_INVARIANT_VIOLATED,
      );
      // 合法 progress 不应触发 invariant（escalated→completed 后结构合法）
      expect(invariantCalls).toHaveLength(0);

      // 但应触发 boot migrate escalated audit
      const migrateCalls = auditWrite.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_BOOT_MIGRATE_ESCALATED,
      );
      expect(migrateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
