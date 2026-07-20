/**
 * ContractSystem 测试 - 状态转换
 * 
 * 构造函数: new ContractSystem({ clawDir, clawId, fs, audit, llm?, toolRegistry, toolTimeoutMs?, fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),})
 * 
 * 新增测试：
 * - loadActive() 按 started_at 排序
 * - 状态验证错误 (pause/resume/cancel)
 * - completeSubtask 覆盖
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsNative from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { ContractCapacityError, ContractArchiveReadError } from '../../src/core/contract/errors.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import {
  prepareContractStaging,
  commitContractStaging,
  readCurrentContractLayout,
} from '../../src/core/contract/new-layout.js';
import { DEAD_PID } from '../helpers/dead-pid.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';
// phase 1351: vi.mock(child_process) removed (was no-op passthrough)
// phase 1351: vi.mock(constants.js LOCK_MAX_RETRIES override) moved to contract_manager-locks.test.ts
// (remaining tests do NOT trigger lock retry path → don't need override)

let testDir: string;
let clawDir: string;

afterEach(async () => {
  vi.restoreAllMocks();
  if (testDir) {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  }
});

describe('ContractSystem', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-manager-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

  it('should create contract with running status and todo subtasks', async () => {
    // Note: create() 创建契约后立即设为 running 状态（manager.ts:141）
    const contractYaml = makeContractYaml();

    const contractId = await manager.create(contractYaml);
    const progress = await manager.getProgress(contractId);
    // FIX: create() 直接设为 running，不是 pending（符合设计：契约一创建就开始执行）
    expect(progress.status).toBe('running');
    // FIX: subtasks 是 Record<string, {...}>，不是数组
    expect(progress.subtasks['task-1'].status).toBe('todo');
  });

  it('should cancel contract and move to archive/cancelled', async () => {
    const contractYaml = makeContractYaml();

    const contractId = await manager.create(contractYaml);
    await manager.cancel(contractId, 'Test cancel');

    // Step C: lifecycle state is committed by directory path, not progress.status.
    const archivePath = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await expect(fs.access(archivePath)).resolves.not.toThrow();
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(activePath)).rejects.toThrow();

    // progress.json no longer carries lifecycle status; derive from subtasks only.
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('todo');
  });

  // === 新增测试：状态转换验证 ===

  it('should throw when cancelling already cancelled contract', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });

    const contractId = await manager.create(contractYaml);
    await manager.cancel(contractId, 'Cancel');
    
    // 再次 cancel 应该抛错
    await expect(manager.cancel(contractId, 'Cancel again')).rejects.toThrow('Cannot cancel');
  });

  // === Phase 1130: capacity=1 create rejection ===

  it('should reject second create while active exists and leave active untouched', async () => {
    const contract1 = await manager.create(makeContractYaml({
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const activePath = path.join(clawDir, 'contract', 'active', contract1);
    const yamlBefore = await fs.readFile(path.join(activePath, 'contract.yaml'), 'utf-8');
    const progressBefore = await fs.readFile(path.join(activePath, 'progress.json'), 'utf-8');
    const onCompleted = vi.fn();
    manager.onContractCompleted(onCompleted);

    await expect(manager.create(makeContractYaml({
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }))).rejects.toBeInstanceOf(ContractCapacityError);

    // active contract unchanged byte-for-byte
    expect(await fs.readFile(path.join(activePath, 'contract.yaml'), 'utf-8')).toBe(yamlBefore);
    expect(await fs.readFile(path.join(activePath, 'progress.json'), 'utf-8')).toBe(progressBefore);

    // no replacement archive
    const archivePath = path.join(clawDir, 'contract', 'archive', 'completed', contract1);
    await expect(fs.access(archivePath)).rejects.toThrow();

    // no completed callback
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('should allow new create after active is cancelled', async () => {
    const contract1 = await manager.create(makeContractYaml({
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contract1, 'release capacity');

    const contract2 = await manager.create(makeContractYaml({
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }));

    const active = await manager.loadActive();
    expect(active?.id).toBe(contract2);

    const progress2 = await manager.getProgress(contract2);
    expect(progress2.status).toBe('running');
  });

  // === 新增测试：completeSubtask 覆盖 ===

  it('should complete subtask and update status', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [
        { id: 'task-1', description: 'Task 1' },
        { id: 'task-2', description: 'Task 2' },
      ],
      verification: [],
    });
    const contractId = await manager.create(contractYaml);
    await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'Task completed' });

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('completed');
    expect(progress.subtasks['task-2'].status).toBe('todo');
  });

  it('should reject unknown subtaskId in completeSubtask with valid IDs', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      verification: [],
    });
    const contractId = await manager.create(contractYaml);
    // 尝试完成不存在的子任务
    const result = await manager.completeSubtask({ 
      contractId, 
      subtaskId: 'unknown-task', 
      evidence: 'Test' 
    });

    // 应该返回失败，并包含有效 ID 列表
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Unknown subtask');
    expect(result.feedback).toContain('task-1');

    // 真正的 task-1 应该仍是 todo
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['task-1'].status).toBe('todo');
  });

  it('should return error feedback on duplicate submit_subtask call for already-completed subtask', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }, { id: 'task-2', description: 'Task 2' }],
      verification: [],
    }));

    // First call: completes successfully
    const first = await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done' });
    expect(first.passed).toBe(true);

    // Second call on already-completed subtask: should return error feedback
    const second = await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'done again' });
    expect(second.passed).toBe(false);
    expect(second.feedback).toContain('already completed');
  });

  it('should mark contract completed when all subtasks done', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [
        { id: 'task-1', description: 'Task 1' },
        { id: 'task-2', description: 'Task 2' },
      ],
      verification: [],
    });
    const contractId = await manager.create(contractYaml);
    // 完成所有子任务
    await manager.completeSubtask({ contractId, subtaskId: 'task-1', evidence: 'Task 1 done' });
    await manager.completeSubtask({ contractId, subtaskId: 'task-2', evidence: 'Task 2 done' });

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('completed');
  });

  it('should throw state validation errors with correct message', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // cancel 后不应该再 cancel
    await manager.cancel(contractId, 'Cancelled');
    await expect(manager.cancel(contractId, 'Try cancel again')).rejects.toThrow('Cannot cancel');
  });

  // === 新增测试：损坏 progress.json 抛出 ToolError ===

  it('should isolate and mark crashed when progress.json is corrupted', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });
    const contractId = await manager.create(contractYaml);
    // 手动损坏 progress.json（create() 创建在 active/ 子目录下）
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(progressPath, '{ broken json', 'utf-8');

    // phase 958: JSON.parse 失败进入隔离 + markCrashed 路径，返回 null
    const result = await manager.getProgress(contractId);
    expect(result).toBeNull();

    // contract 被移到 archive/corrupted
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
    await expect(fs.stat(archiveContractDir)).resolves.toBeDefined();

    // 损坏文件被隔离
    const corruptedDir = path.join(archiveContractDir, 'corrupted');
    const corruptedFiles = await fs.readdir(corruptedDir);
    expect(corruptedFiles.length).toBeGreaterThan(0);
    expect(corruptedFiles[0]).toMatch(/^\d+_[a-zA-Z0-9-]+_progress\.json$/);
  });

  // === Phase 22 H1: acquireLock EEXIST retry ===


  // Note: runScriptVerification tests removed - implementation now uses execFile (async)
  // New tests for async script verification should be added in future phases

  // === Phase 22 C1+C2: completeSubtask allCompleted path ===

  it('should return allCompleted=true and archive contract when last subtask completes', async () => {
    const onNotifySpy = vi.fn();
    const testManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: makeMockAudit(),
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    testManager.setOnNotify(onNotifySpy);

    const contractId = await testManager.create(makeContractYaml({
      title: 'AllCompleted Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    expect(result.passed).toBe(true);
    expect(result.allCompleted).toBe(true);

    // 契约已移入 archive/completed（active/ 目录不再存在）
    const archivePath = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await expect(fs.access(archivePath)).resolves.not.toThrow();
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(activePath)).rejects.toThrow();

    // phase 738: contract_completed notify emitted on archive success
    const completedEvents = onNotifySpy.mock.calls.filter(
      (call: any[]) => call[0] === 'contract_completed'
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0][1]).toMatchObject({
      contractId: expect.any(String),
      title: 'AllCompleted Test',
    });
  });

  it('should not set allCompleted when subtasks remain', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Partial Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    const result = await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    expect(result.passed).toBe(true);
    expect(result.allCompleted).toBe(false);

    // 契约仍在 active/
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(activePath)).resolves.not.toThrow();
  });

  describe('runScriptVerification', () => {
    it('runScriptVerification passes for script without shebang', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-shebang-'));
      const testClawDir = path.join(tempDir, 'claws', 'test-claw');
      await fs.mkdir(testClawDir, { recursive: true });

      // 创建无 shebang 的验收脚本
      const scriptPath = path.join(testClawDir, 'verification', 'task-1.sh');
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, 'echo ok\n', { mode: 0o644 });

      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({
        clawDir: testClawDir,
        clawId: 'test-claw',
        fs: new NodeFileSystem({ baseDir: testClawDir }),
        audit: mockAudit,
        toolRegistry: createToolRegistry(),
        fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      // @ts-expect-error - runScriptVerification is private
      const result = await testManager.runScriptVerification('task-1.sh', path.join(testClawDir, 'verification'));

      expect(result.passed).toBe(true);

      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    });
  });

  describe('current layout integration', () => {
    it('reads and updates a current-layout fixture via manager runtime boundary', async () => {
      const currentYaml = {
        ...makeContractYaml({
          subtasks: [
            { id: 't1', description: 'T1' },
            { id: 't2', description: 'T2' },
          ],
          verification: [],
        }),
        id: 'cid-current',
      };

      const staging = await prepareContractStaging(
        { fs: nodeFs, audit: makeMockAudit() },
        { creationId: 'create-1', contract: currentYaml as any },
      );
      await commitContractStaging({ fs: nodeFs, audit: makeMockAudit() }, staging);

      const active = await manager.loadActive();
      expect(active).not.toBeNull();
      expect(active!.id).toBe('cid-current');
      expect(active!.subtasks.map(st => st.id)).toEqual(['t1', 't2']);

      const progress = await manager.getProgress('cid-current' as any);
      expect(progress).not.toBeNull();
      expect(progress!.contract_id).toBe('cid-current');
      expect(progress!.subtasks.t1.status).toBe('todo');
      expect(progress!.subtasks.t2.status).toBe('todo');

      // Single subtask update through the atomic current boundary.
      const updated = { ...progress! };
      updated.subtasks = { ...updated.subtasks };
      updated.subtasks.t1 = {
        ...updated.subtasks.t1,
        status: 'completed',
        completed_at: '2026-07-19T10:05:00Z',
        evidence: 'done',
      };

      // @ts-expect-error - saveProgress is private
      await manager.saveProgress('cid-current' as any, updated);

      const after = await manager.getProgress('cid-current' as any);
      expect(after!.subtasks.t1.status).toBe('completed');
      expect(after!.subtasks.t2.status).toBe('todo');

      const layout = await readCurrentContractLayout({ fs: nodeFs, audit: makeMockAudit() });
      expect(layout!.subtasks.get('t1')?.status).toBe('completed');
      expect(layout!.subtasks.get('t2')?.status).toBe('todo');
    });

    it('manager.create still writes legacy active layout', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Legacy Writer',
        goal: 'Legacy',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      const legacyPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
      await expect(fs.access(legacyPath)).resolves.not.toThrow();
      const currentPath = path.join(clawDir, 'contract', 'active', 'current');
      await expect(fs.access(currentPath)).rejects.toThrow();
    });
  });

  // === Phase 1145 Step C: archive getProgress routing ===

  describe('archive getProgress routing', () => {
    it('reads current-format archive from a manually constructed fixture', async () => {
      const root = path.join(clawDir, 'contract', 'archive', 'completed', 'cid-current-archive');
      const subtasksDir = path.join(root, 'subtasks');
      await fs.mkdir(subtasksDir, { recursive: true });
      const contractYaml = {
        schema_version: 1,
        id: 'cid-current-archive',
        title: 'Current Archive',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
      };
      await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contractYaml), 'utf-8');
      const record = {
        schema_version: 1,
        subtask_id: 't1',
        status: 'completed',
        attempts: [],
        completed_at: '2026-07-19T10:05:00Z',
      };
      await fs.writeFile(path.join(subtasksDir, 't1.json'), JSON.stringify(record), 'utf-8');

      const archived = await manager.getProgress('cid-current-archive' as any);
      expect(archived).not.toBeNull();
      expect(archived!.contract_id).toBe('cid-current-archive');
      expect(archived!.subtasks.t1.status).toBe('completed');
    });

    it('reads legacy-format archive after cancel', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Legacy Archive Reader',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));
      await manager.cancel(contractId, 'archive reader test');

      const progress = await manager.getProgress(contractId);
      expect(progress).not.toBeNull();
      expect(progress!.contract_id).toBe(contractId);
      expect(progress!.subtasks.t1.status).toBe('todo');
    });

    it('propagates archive reader issue as ContractArchiveReadError', async () => {
      const root = path.join(clawDir, 'contract', 'archive', 'completed', 'cid-current-issue');
      const subtasksDir = path.join(root, 'subtasks');
      await fs.mkdir(subtasksDir, { recursive: true });
      const contractYaml = {
        schema_version: 1,
        id: 'cid-current-issue',
        title: 'Current Archive Issue',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
      };
      await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contractYaml), 'utf-8');
      await fs.writeFile(path.join(subtasksDir, 't1.json'), 'not json', 'utf-8');

      await expect(manager.getProgress('cid-current-issue' as any)).rejects.toBeInstanceOf(ContractArchiveReadError);
    });

    it('still isolates and marks corrupted for legacy active progress.json corruption', async () => {
      const contractId = await manager.create(makeContractYaml({
        title: 'Legacy Active Corrupt',
        goal: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));
      const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
      await fs.writeFile(progressPath, '{ broken json', 'utf-8');

      const result = await manager.getProgress(contractId);
      expect(result).toBeNull();

      const corruptedDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);
      await expect(fs.stat(corruptedDir)).resolves.toBeDefined();
    });
  });
});
