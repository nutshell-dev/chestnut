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
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { DEAD_PID } from '../helpers/dead-pid.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';
// phase 1351: vi.mock(child_process) removed (was no-op passthrough)
// phase 1351: vi.mock(constants.js LOCK_MAX_RETRIES override) moved to contract_manager-locks.test.ts
// (remaining tests do NOT trigger lock retry path → don't need override)

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
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

  it('should pause and resume contract', async () => {
    const contractYaml = makeContractYaml();

    const contractId = await manager.create(contractYaml);
    
    // Pause
    await manager.pause(contractId, 'Test pause');
    let progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('paused');

    // Resume
    await manager.resume(contractId);
    progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('running');
  });

  it('should cancel contract', async () => {
    const contractYaml = makeContractYaml();

    const contractId = await manager.create(contractYaml);
    await manager.cancel(contractId, 'Test cancel');

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');
  });

  // === 新增测试：状态转换验证 ===
  
  it('should throw when pausing non-running contract', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });

    const contractId = await manager.create(contractYaml);
    await manager.pause(contractId, 'First pause');
    
    // 第二次 pause 应该抛错
    await expect(manager.pause(contractId, 'Second pause')).rejects.toThrow('Cannot pause');
  });

  it('should throw when resuming non-paused contract', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });

    const contractId = await manager.create(contractYaml);
    // running 状态不能 resume
    await expect(manager.resume(contractId)).rejects.toThrow('Cannot resume');
  });

  it('should throw when cancelling already completed contract', async () => {
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

  // === 新增测试：loadActive 返回最新的 running 契约 ===
  
  it('should loadActive return latest running contract by started_at', async () => {
    // 创建第一个契约
    const contract1 = await manager.create(makeContractYaml({
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));
    
    // 稍微等待确保时间戳不同
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    
    // 创建第二个契约（会自动归档第一个）
    const contract2 = await manager.create(makeContractYaml({
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }));

    // loadActive 应该返回最新的（第二个），第一个已被归档
    const active = await manager.loadActive();
    expect(active?.id).toBe(contract2);
    
    // 验证第一个已被归档
    const progress1 = await manager.getProgress(contract1);
    expect(progress1.status).toBe('completed'); // phase 188: auto-archive flips to completed before archive
  });

  it('should create() auto-archive existing running contract', async () => {
    const contract1 = await manager.create(makeContractYaml({
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // 创建第二个，第一个应该被归档（不是暂停）
    const contract2 = await manager.create(makeContractYaml({
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }));

    // 第一个被归档（phase 188: auto-archive flips to completed before archive）
    const progress1 = await manager.getProgress(contract1);
    expect(progress1.status).toBe('completed');
    
    // 第二个是当前的 active
    const progress2 = await manager.getProgress(contract2);
    expect(progress2.status).toBe('running');
    
    // loadActive 只返回第二个
    const active = await manager.loadActive();
    expect(active?.id).toBe(contract2);
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

    // cancel 后不应该能 pause
    await manager.cancel(contractId, 'Cancelled');
    await expect(manager.pause(contractId, 'Try pause')).rejects.toThrow('Cannot pause');
  });

  // === 新增测试：损坏 progress.json 抛出 ToolError ===

  it('should throw ToolError when progress.json is corrupted', async () => {
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

    // 应该抛出包含解析错误的 ToolError
    await expect(manager.getProgress(contractId)).rejects.toThrow(/parse|JSON|Unexpected token/i);
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

    // 契约已移入 archive（active/ 目录不再存在）
    const archivePath = path.join(clawDir, 'contract', 'archive', contractId);
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
    });
  });

});
