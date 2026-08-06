/**
 * ContractSystem audit lifecycle + moveToArchive tests (phase 1347 split)
 *
 * Extracted from contract_manager.test.ts:697-889 (phase230 audit events + moveToArchive describes).
 * 6 tests / fast project / no vi.mock for spawn or constants (uses moveSpy / mockAudit only).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';
import { completeSubtask } from '../helpers/contract-subtask.js';


let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem - audit lifecycle + moveToArchive (phase 1347 split)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-archive-audit-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  describe('phase230 audit events', () => {
    it('allows second active create and emits CREATED for both', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit,
        toolRegistry: createToolRegistry(),
        fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contract1 = await testManager.create(makeContractYaml({
        id: 'first-active',
        title: 'First',
        goal: 'First',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      const contract2 = await testManager.create(makeContractYaml({
        id: 'second-active',
        title: 'Second',
        goal: 'Second',
        subtasks: [{ id: 't2', description: 'T2' }],
        verification: [],
      }));

      expect(contract2).toBe('second-active');

      const createdEvents = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CREATED,
      );
      expect(createdEvents).toHaveLength(2);
      expect(createdEvents.some((c) => c.some((col) => typeof col === 'string' && col.includes(`contractId=${contract1}`)))).toBe(true);
      expect(createdEvents.some((c) => c.some((col) => typeof col === 'string' && col.includes('contractId=second-active')))).toBe(true);
    });

    it('writes CONTRACT_CREATION_INTERRUPTED audit when materialize fails (no destructive rollback)', async () => {
      const writeAtomicSpy = vi.spyOn(nodeFs, 'writeAtomic').mockImplementation(async (p: string, c: string) => {
        if (p.includes('progress.json')) throw new Error('disk full');
        return fs.writeFile(path.join(clawDir, p), c);
      });
      const removeDirSpy = vi.spyOn(nodeFs, 'removeDir').mockRejectedValue(new Error('rm failed'));

      const mockAudit = makeMockAudit();
      const failManager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit,
        toolRegistry: createToolRegistry(),
        fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      await expect(failManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }))).rejects.toThrow('disk full');

      expect(writeAtomicSpy).toHaveBeenCalledWith(expect.stringContaining('progress.json'), expect.any(String));
      expect(removeDirSpy).not.toHaveBeenCalled();
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_INTERRUPTED,
        expect.stringContaining('contractId='),
        expect.stringContaining('started_at='),
        expect.stringContaining('boundary=materialize_or_publish'),
        expect.stringContaining('error='),
      );
      expect(mockAudit.write).not.toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ROLLBACK_FAILED,
        expect.anything(),
        expect.anything(),
      );
    });

    it('writes CONTRACT_NOTIFY_FAILED audit when onNotify throws during create', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit,
        toolRegistry: createToolRegistry(),
        fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      testManager.setOnNotify(() => {
        throw new Error('notify crash');
      });

      await testManager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
        expect.stringContaining('notify crash'),
      );
    });

    it('writes CONTRACT_MOVE_ARCHIVE_FAILED audit when moveToArchive fails on completion', async () => {
      const mockAudit = makeMockAudit();
      const onNotifySpy = vi.fn();
      const testManager = new ContractSystem({
        clawDir,
        clawId: 'test-claw',
        fs: nodeFs,
        audit: mockAudit,
        toolRegistry: createToolRegistry(),
        fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      testManager.setOnNotify(onNotifySpy);

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      const moveSpy = vi.spyOn(nodeFs, 'moveDir').mockRejectedValue(new Error('disk full'));
      await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
        expect.stringContaining('context=ContractSystem._completeSubtaskSync'),
        expect.stringContaining('message=terminal commit failed'),
        expect.stringContaining('disk full'),
      );

      // phase 738 reverse 3: contract_completed notify NOT emitted on archive failure
      const completedEvents = onNotifySpy.mock.calls.filter(
        (call: any[]) => call[0].type === 'contract_completed'
      );
      expect(completedEvents).toHaveLength(0);

      moveSpy.mockRestore();
    });
  });

  describe('moveToArchive and audit consistency', () => {
    it('should NOT write audit when moveToArchive fails', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      // Create contract with no-op verification (no script_file/prompt_file = no verification)
      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      // Spy on fs.moveDir to make the terminal directory rename fail.
      const moveSpy = vi.spyOn(nodeFs, 'moveDir').mockRejectedValue(new Error('disk full'));

      // Complete the subtask (no verification = allCompleted = true, sync path)
      await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });

      // The terminal commit failed; no title-bearing completion audit should run.
      // updateContractStatus already writes contract_completed; the additional
      // title-bearing audit in _completeSubtaskSync should not run on failure
      const titleAuditCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === 'contract_completed' && c.some((arg: any) => String(arg).includes('title='))
      );
      expect(titleAuditCalls).toHaveLength(0);
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
        expect.stringContaining('context=ContractSystem._completeSubtaskSync'),
        expect.anything(),
        expect.anything(),
      );

      moveSpy.mockRestore();
    });

    it('should write audit when moveToArchive succeeds', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });

      // phase 705: contractId 加 key= prefix
      expect(mockAudit.write).toHaveBeenCalledWith(CONTRACT_AUDIT_EVENTS.COMPLETED, `contractId=${contractId}`, 'title=Test', expect.stringContaining('claw='));
    });
  });
});