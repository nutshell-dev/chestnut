/**
 * ContractSystem 测试 - 状态转换
 * 
 * 构造函数: new ContractSystem(clawDir, clawId, fs, audit, llm?, verifierScheduler?)
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
import { waitFor } from '../helpers/wait-for.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { DEAD_PID } from '../helpers/dead-pid.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual };
});

vi.mock('../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,        // 从 20 降到 3
    LOCK_RETRY_DELAY_MS: 10,    // 从 500ms 降到 10ms
  };
});

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-manager-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = { write: vi.fn() };
    manager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());
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
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
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
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    });

    const contractId = await manager.create(contractYaml);
    // running 状态不能 resume
    await expect(manager.resume(contractId)).rejects.toThrow('Cannot resume');
  });

  it('should throw when cancelling already completed contract', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
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
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));
    
    // 稍微等待确保时间戳不同
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    
    // 创建第二个契约（会自动归档第一个）
    const contract2 = await manager.create(makeContractYaml({
      title: 'Second',
      goal: 'Second',
      deliverables: [],
      subtasks: [{ id: 't2', description: 'T2' }],
      acceptance: [],
    }));

    // loadActive 应该返回最新的（第二个），第一个已被归档
    const active = await manager.loadActive();
    expect(active?.id).toBe(contract2);
    
    // 验证第一个已被归档
    const progress1 = await manager.getProgress(contract1);
    expect(progress1.status).toBe('running'); // status 不变，但位置在 archive/
  });

  it('should create() auto-archive existing running contract', async () => {
    const contract1 = await manager.create(makeContractYaml({
      title: 'First',
      goal: 'First',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    // 创建第二个，第一个应该被归档（不是暂停）
    const contract2 = await manager.create(makeContractYaml({
      title: 'Second',
      goal: 'Second',
      deliverables: [],
      subtasks: [{ id: 't2', description: 'T2' }],
      acceptance: [],
    }));

    // 第一个被归档（status 仍为 running，但不在 active/）
    const progress1 = await manager.getProgress(contract1);
    expect(progress1.status).toBe('running');
    
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
      deliverables: [],
      subtasks: [
        { id: 'task-1', description: 'Task 1' },
        { id: 'task-2', description: 'Task 2' },
      ],
      acceptance: [],
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
      deliverables: [],
      acceptance: [],
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

  it('should return error feedback on duplicate done() call for already-completed subtask', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 'task-1', description: 'Task 1' }, { id: 'task-2', description: 'Task 2' }],
      acceptance: [],
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
      deliverables: [],
      subtasks: [
        { id: 'task-1', description: 'Task 1' },
        { id: 'task-2', description: 'Task 2' },
      ],
      acceptance: [],
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
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
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
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    });
    const contractId = await manager.create(contractYaml);
    // 手动损坏 progress.json（create() 创建在 active/ 子目录下）
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(progressPath, '{ broken json', 'utf-8');

    // 应该抛出包含解析错误的 ToolError
    await expect(manager.getProgress(contractId)).rejects.toThrow(/parse|JSON|Unexpected token/i);
  });

  // === Phase 22 H1: acquireLock EEXIST retry ===

  it('should acquire lock after EEXIST retry when lock is released mid-wait', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Lock Retry Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    // 预先写入锁文件，模拟另一个进程持有锁
    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, '{}', 'utf-8');

    // pause() 先 fs.move(active → paused)，锁文件随目录一起移动到 paused/。
    // 50ms 后从移动后的位置释放锁，确保第二次重试能拿到锁
    const movedLockPath = path.join(clawDir, 'contract', 'paused', contractId, 'progress.lock');
    setTimeout(() => fs.unlink(movedLockPath).catch(() => {}), 50);

    // pause() 内部走 acquireLock → 第一次 EEXIST → wait 100ms → 锁已释放 → 第二次成功
    await expect(manager.pause(contractId, 'checkpoint')).resolves.not.toThrow();
  }, 2000);

  it('should throw ToolError when lock is never released and retries exhausted', async () => {
    // LOCK_MAX_RETRIES=3, LOCK_RETRY_DELAY_MS=10ms (mocked in constants)
    const contractId = await manager.create(makeContractYaml({
      title: 'Lock Exhaust Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    // 写入锁文件（持有者 = 当前进程，模拟活跃锁），不释放
    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, time: Date.now() }), 'utf-8');

    await expect(manager.pause(contractId, 'checkpoint'))
      .rejects.toThrow(/Failed to acquire lock after/);
  }, 2000);

  it('should audit cleanup failure when unlinking stale lock fails (EACCES)', async () => {
    const mockAudit = { write: vi.fn() };
    const testManager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry()
    );

    const contractId = await testManager.create(makeContractYaml({
      title: 'Lock Cleanup AuditLog',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    // 写 stale lock：持有者 PID 不存在（process.kill(deadPid, 0) 会 ESRCH）
    const deadPid = DEAD_PID;
    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, time: Date.now() }), 'utf-8');

    // 针对 progress.lock 的 unlink 抛 EACCES；其他路径（如 writeAtomic 的 tmp 文件）走原函数
    const realUnlink = fsNative.promises.unlink.bind(fsNative.promises);
    const unlinkSpy = vi.spyOn(fsNative.promises, 'unlink').mockImplementation(async (p: any) => {
      if (String(p).endsWith('progress.lock')) {
        const err: any = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return realUnlink(p);
    });

    try {
      // unlink 持续失败 → LOCK_MAX_RETRIES 耗尽 → 抛 ToolError
      await expect(testManager.pause(contractId, 'checkpoint'))
        .rejects.toThrow(/Failed to acquire lock after/);

      // 每次重试走 unlinkStaleLock 失败路径 → audit 至少一次
      const cleanupCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === 'contract_lock_cleanup_failed'
      );
      expect(cleanupCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      // 参数：type, reason, code, message
      expect(cleanupCalls[0][1]).toBe(`stale_pid_${deadPid}`);
      expect(cleanupCalls[0][2]).toBe('EACCES');
      expect(cleanupCalls[0][3]).toContain('permission denied');
    } finally {
      unlinkSpy.mockRestore();
    }
  }, 2000);

  it('should NOT audit when stale lock is already gone (ENOENT)', async () => {
    const mockAudit = { write: vi.fn() };
    const testManager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry()
    );

    const contractId = await testManager.create(makeContractYaml({
      title: 'Lock Cleanup ENOENT',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    const deadPid = DEAD_PID;
    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, time: Date.now() }), 'utf-8');

    // 模拟"已被其他路径清理"：unlink 对 progress.lock 抛 ENOENT
    const realUnlink = fsNative.promises.unlink.bind(fsNative.promises);
    const unlinkSpy = vi.spyOn(fsNative.promises, 'unlink').mockImplementation(async (p: any) => {
      if (String(p).endsWith('progress.lock')) {
        // 先实际删除一次，再把后续 unlink 都当成 ENOENT（模拟"外部已清理"）
        await realUnlink(p).catch(() => {});
        const err: any = new Error('no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return realUnlink(p);
    });

    try {
      // unlinkStaleLock 看到 ENOENT 返回 true → 走 continue 立即重试 → 此时锁已真的不存在 → 获取成功
      await expect(testManager.pause(contractId, 'checkpoint')).resolves.not.toThrow();

      const cleanupCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === 'contract_lock_cleanup_failed'
      );
      expect(cleanupCalls).toHaveLength(0);
    } finally {
      unlinkSpy.mockRestore();
    }
  }, 2000);

  // Note: runScriptAcceptance tests removed - implementation now uses execFile (async)
  // New tests for async script acceptance should be added in future phases

  // === Phase 22 C1+C2: completeSubtask allCompleted path ===

  it('should return allCompleted=true and archive contract when last subtask completes', async () => {
    const onNotifySpy = vi.fn();
    const testManager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, { write: vi.fn() } as any, undefined, createToolRegistry()
    );
    testManager.setOnNotify(onNotifySpy);

    const contractId = await testManager.create(makeContractYaml({
      title: 'AllCompleted Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
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
      deliverables: [],
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      acceptance: [],
    }));

    const result = await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    expect(result.passed).toBe(true);
    expect(result.allCompleted).toBe(false);

    // 契约仍在 active/
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(activePath)).resolves.not.toThrow();
  });

  describe('monitor error reporting', () => {
    it('should log error to monitor when loadActive finds corrupted progress.json', async () => {
      const mockAudit = { write: vi.fn() };
      const monitorManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      // 写入损坏的 progress.json
      const contractId = 'corrupt-contract';
      const contractDir = path.join(clawDir, 'contract', 'active', contractId);
      await fs.mkdir(contractDir, { recursive: true });
      await fs.writeFile(path.join(contractDir, 'progress.json'), '{ invalid json !!');

      const result = await monitorManager.loadActive();
      expect(result).toBeNull(); // 损坏的契约被跳过，返回 null
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('context=ContractSystem.loadActive'),
        expect.stringContaining('contractId=corrupt-contract'),
        expect.anything(),
      );
    });

    it('should log error to monitor when loadPaused finds corrupted progress.json', async () => {
      const mockAudit = { write: vi.fn() };
      const monitorManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = 'corrupt-paused-contract';
      const contractDir = path.join(clawDir, 'contract', 'paused', contractId);
      await fs.mkdir(contractDir, { recursive: true });
      await fs.writeFile(path.join(contractDir, 'progress.json'), '{ bad json ]');

      const result = await monitorManager.loadPaused();
      expect(result).toBeNull();
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('context=ContractSystem.loadPaused'),
        expect.stringContaining('contractId=corrupt-paused-contract'),
        expect.stringContaining('error='),
      );
    });

    it('should log warn to monitor when unknown subtaskId is used in completeSubtask', async () => {
      const mockAudit = { write: vi.fn() };
      const monitorManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await monitorManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 'real-task', description: 'Real task' }],
        acceptance: [],
      }));

      const result = await monitorManager.completeSubtask({
        contractId,
        subtaskId: 'nonexistent-task',
        evidence: 'evidence',
      });

      expect(result.passed).toBe(false);
      expect(result.feedback).toContain('nonexistent-task');
      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        expect.stringContaining('context=ContractSystem._completeSubtaskSync'),
        expect.anything(),
        expect.stringContaining('subtaskId=nonexistent-task'),
        expect.stringContaining('message=Unknown subtaskId'),
      );
    });

    it('should clean up contract.yaml if progress.json write fails', async () => {
      // spy writeAtomic，对 progress.json 抛错
      vi.spyOn(nodeFs, 'writeAtomic').mockImplementation(async (p: string, c: string) => {
        if (p.includes('progress.json')) throw new Error('disk full');
        // 其他调用走真实实现
        return fs.writeFile(path.join(clawDir, p), c);
      });

      const mockAudit = { write: vi.fn() };
      const failManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());
      await expect(failManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }))).rejects.toThrow('disk full');

      // active/ 下不应存在任何 contract.yaml
      const activeDir = path.join(clawDir, 'contract', 'active');
      const dirs = await fs.readdir(activeDir).catch(() => [] as string[]);
      for (const dir of dirs) {
        const yamlPath = path.join(activeDir, dir, 'contract.yaml');
        await expect(fs.access(yamlPath)).rejects.toThrow(); // ENOENT
      }
    });
  });

  describe('acceptance validation', () => {
    it('should throw when type is "script" but prompt_file is used', async () => {
      await expect(manager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          // @ts-expect-error - intentionally wrong field for testing
          { subtask_id: 't1', type: 'script', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }))).rejects.toThrow('script_file');
    });

    it('should throw when type is "llm" but script_file is used', async () => {
      await expect(manager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          // @ts-expect-error - intentionally wrong field for testing
          { subtask_id: 't1', type: 'llm', script_file: 'acceptance/t1.sh' },
        ],
      }))).rejects.toThrow('prompt_file');
    });
  });

  describe('runScriptAcceptance', () => {
    it('runScriptAcceptance passes for script without shebang', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-shebang-'));
      const testClawDir = path.join(tempDir, 'claws', 'test-claw');
      await fs.mkdir(testClawDir, { recursive: true });

      // 创建无 shebang 的验收脚本
      const scriptPath = path.join(testClawDir, 'acceptance', 'task-1.sh');
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, 'echo ok\n', { mode: 0o644 });

      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(testClawDir, 'test-claw', new NodeFileSystem({ baseDir: testClawDir }), mockAudit as any, undefined, createToolRegistry());
      // @ts-expect-error - runScriptAcceptance is private
      const result = await testManager.runScriptAcceptance('task-1.sh', path.join(testClawDir, 'acceptance'));

      expect(result.passed).toBe(true);
    });
  });

  describe('phase230 audit events', () => {
    it('writes CONTRACT_ARCHIVE_STARTED audit when auto-archiving existing contract', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(
        clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry()
      );

      const contract1 = await testManager.create(makeContractYaml({
        title: 'First',
        goal: 'First',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      const contract2 = await testManager.create(makeContractYaml({
        title: 'Second',
        goal: 'Second',
        deliverables: [],
        subtasks: [{ id: 't2', description: 'T2' }],
        acceptance: [],
      }));

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ARCHIVE_STARTED,
        `old=${contract1}`,
        `new=${contract2}`,
      );
    });

    it('writes CONTRACT_ROLLBACK_FAILED audit when contract dir rollback fails', async () => {
      vi.spyOn(nodeFs, 'writeAtomic').mockImplementation(async (p: string, c: string) => {
        if (p.includes('progress.json')) throw new Error('disk full');
        return fs.writeFile(path.join(clawDir, p), c);
      });
      vi.spyOn(nodeFs, 'removeDir').mockRejectedValue(new Error('rm failed'));

      const mockAudit = { write: vi.fn() };
      const failManager = new ContractSystem(
        clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry()
      );

      await expect(failManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }))).rejects.toThrow('disk full');

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ROLLBACK_FAILED,
        expect.stringContaining('contractId='),
        expect.stringContaining('error='),
      );
    });

    it('writes CONTRACT_NOTIFY_FAILED audit when onNotify throws during create', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(
        clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry()
      );

      testManager.setOnNotify(() => {
        throw new Error('notify crash');
      });

      await testManager.create(makeContractYaml({
        title: 'Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
        expect.stringContaining('notify crash'),
      );
    });

    it('writes CONTRACT_MOVE_ARCHIVE_FAILED audit when moveToArchive fails on completion', async () => {
      const mockAudit = { write: vi.fn() };
      const onNotifySpy = vi.fn();
      const testManager = new ContractSystem(
        clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry()
      );
      testManager.setOnNotify(onNotifySpy);

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      const moveSpy = vi.spyOn(testManager as any, 'moveToArchive').mockRejectedValue(new Error('disk full'));
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
        expect.stringContaining('context=ContractSystem._completeSubtaskSync'),
        expect.stringContaining('message=moveToArchive failed; progress.status reverted to running for retry'),
        expect.stringContaining('error=disk full'),
      );

      // phase 738 reverse 3: contract_completed notify NOT emitted on archive failure
      const completedEvents = onNotifySpy.mock.calls.filter(
        (call: any[]) => call[0] === 'contract_completed'
      );
      expect(completedEvents).toHaveLength(0);

      moveSpy.mockRestore();
    });
  });

  describe('moveToArchive and audit consistency', () => {
    it('should NOT write audit when moveToArchive fails', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      // Create contract with no-op acceptance (no script_file/prompt_file = no acceptance)
      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      // Spy on moveToArchive to make it fail
      const moveSpy = vi.spyOn(testManager as any, 'moveToArchive').mockRejectedValue(new Error('disk full'));

      // Complete the subtask (no acceptance = allCompleted = true, sync path)
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      expect(moveSpy).toHaveBeenCalledWith(contractId);
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
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      // Spy but let it work normally
      const moveSpy = vi.spyOn(testManager as any, 'moveToArchive').mockResolvedValue(undefined);

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      expect(moveSpy).toHaveBeenCalledWith(contractId);
      expect(mockAudit.write).toHaveBeenCalledWith(CONTRACT_AUDIT_EVENTS.COMPLETED, contractId, 'title=Test', expect.stringContaining('claw='));

      moveSpy.mockRestore();
    });
  });

  describe('LLM acceptance', () => {
    it('should reset subtask to todo when verifier throws exception', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      // Create contract with LLM acceptance
      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }));

      // Create prompt file (use native fs with absolute path)
      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(
        path.join(contractDir, 'acceptance', 't1.prompt.txt'),
        'Check: {{evidence}}, {{artifacts}}'
      );

      // Mock runLLMAcceptance to throw MaxStepsExceeded
      const runLLMSpy = vi.spyOn(testManager as any, 'runLLMAcceptance').mockRejectedValue(
        new Error('MaxStepsExceeded: step limit 50 exceeded')
      );

      // Complete subtask (triggers background LLM acceptance)
      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      // Should indicate async processing
      expect(result.async).toBe(true);

      // Wait for background processing to complete
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      runLLMSpy.mockRestore();

      // Verify subtask was reset to todo (not stuck in in_progress)
      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBe(1);
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('MaxStepsExceeded');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('programming_bug');
    });

    it('should use DEFAULT_MAX_STEPS=1000 for verifier', async () => {
      // Verify the verifier uses the default max steps (unified with other subagents)
      const { DEFAULT_MAX_STEPS } = await import('../../src/core/agent-executor/index.js');
      expect(DEFAULT_MAX_STEPS).toBe(1000);
    });
  });

  // === Phase 137: escalated_at written when retry_count reaches maxRetries ===

  describe('escalation writes escalated_at', () => {
    it('should set escalated_at after reaching max retries', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Escalation Test',
        goal: 'Test escalated_at',
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'script', script_file: 'acceptance/t1.sh' },
        ],
      }));

      // Create script file so acceptance config resolves
      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'acceptance', 't1.sh'), 0o755);

      // Mock runScriptAcceptance to always reject
      const scriptSpy = vi.spyOn(testManager as any, 'runScriptAcceptance').mockResolvedValue({
        passed: false,
        feedback: 'acceptance failed',
        structured: { passed: false, reason: 'test', issues: [] },
      });

      // Default maxRetries = 3, need 3 failures to trigger escalation
      for (let i = 0; i < 3; i++) {
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        // Wait for background acceptance to complete (subtask leaves in_progress)
        await waitFor(
          async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
          5000,
          10,
        );
      }

      // Escalation saveProgress runs after inbox write; poll for escalated_at
      await waitFor(
        async () => Boolean((await testManager.getProgress(contractId)).subtasks['t1'].escalated_at),
        5000,
        10,
      );

      scriptSpy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].escalated_at).toBeDefined();
      expect(new Date(progress.subtasks['t1'].escalated_at!).getTime()).toBeGreaterThan(0);
    });

    it('should not set escalated_at before reaching max retries', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'No Escalation Test',
        goal: 'Test no escalated_at',
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'script', script_file: 'acceptance/t1.sh' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'acceptance', 't1.sh'), 0o755);

      const scriptSpy = vi.spyOn(testManager as any, 'runScriptAcceptance').mockResolvedValue({
        passed: false,
        feedback: 'acceptance failed',
      });

      // Only 2 failures — below maxRetries (3)
      for (let i = 0; i < 2; i++) {
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await waitFor(
          async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
          5000,
          10,
        );
      }

      scriptSpy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(2);
      expect(progress.subtasks['t1'].escalated_at).toBeUndefined();
    });
  });

  // === Phase 97 Step 44: Contract / SubTask 删字段验证 ===

  describe('Contract shape after field removal (Step 44)', () => {
    const minimalYaml = makeContractYaml({
      title: 'Shape Test',
      goal: 'Verify contract shape',
      subtasks: [
        { id: 'st-1', description: 'Subtask 1' },
        { id: 'st-2', description: 'Subtask 2' },
      ],
      acceptance: [
        { subtask_id: 'st-1', type: 'script', script_file: 'acceptance/st-1.sh' },
        { subtask_id: 'st-2', type: 'script', script_file: 'acceptance/st-2.sh' },
      ],
    });

    it('loadActive() 返回的 Contract 不含已删字段', async () => {
      await manager.create(minimalYaml);
      const contract = await manager.loadActive();
      expect(contract).not.toBeNull();

      // 已删字段不存在于返回对象
      expect(contract).not.toHaveProperty('deliverables');
      expect(contract).not.toHaveProperty('context_files');
      expect(contract).not.toHaveProperty('skills');
      expect(contract).not.toHaveProperty('deadline');
      expect(contract).not.toHaveProperty('output_files');
      expect(contract).not.toHaveProperty('result_summary');
      expect(contract).not.toHaveProperty('error_message');
      expect(contract).not.toHaveProperty('assignee');
    });

    it('SubTask 对象不含已删字段', async () => {
      const contractId = await manager.create(minimalYaml);
      await manager.pause(contractId, 'test');
      const contract = await manager.resume(contractId);

      for (const subtask of contract.subtasks) {
        expect(subtask).not.toHaveProperty('assignee');
        expect(subtask).not.toHaveProperty('result');
        expect(subtask).not.toHaveProperty('error');
      }
    });

    it('必填字段始终存在且类型正确', async () => {
      await manager.create(minimalYaml);
      const contract = await manager.loadActive();
      expect(contract).not.toBeNull();

      expect(typeof contract!.id).toBe('string');
      expect(typeof contract!.title).toBe('string');
      expect(typeof contract!.goal).toBe('string');
      expect(contract!.priority).toBe('normal');
      expect(contract!.creator).toBe('system');
      expect(['auto', 'notify', 'confirm']).toContain(contract!.auth_level);
      expect(Array.isArray(contract!.subtasks)).toBe(true);
    });

    it('SubTask 必填字段完整', async () => {
      const contractId = await manager.create(minimalYaml);
      await manager.pause(contractId, 'test');
      const contract = await manager.resume(contractId);

      expect(contract.subtasks).toHaveLength(2);
      for (const subtask of contract.subtasks) {
        expect(typeof subtask.id).toBe('string');
        expect(typeof subtask.description).toBe('string');
        expect(['todo', 'in_progress', 'completed', 'failed']).toContain(subtask.status);
        expect(typeof subtask.created_at).toBe('string');
        expect(typeof subtask.updated_at).toBe('string');
      }
    });
  });

  // === Phase 239: B.2 Monitor 废止 sub-phase 1 — audit 生命周期事件断言 ===

  describe('phase239 audit lifecycle events', () => {
    it('writes CONTRACT_CREATED audit on contract creation', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'AuditLog Lifecycle Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.CREATED,
        contractId,
        expect.stringContaining('subtasks=1'),
        expect.stringContaining('title=AuditLog Lifecycle Test'),
      );
    });

    it('writes CONTRACT_ACCEPTANCE_STARTED audit when async acceptance begins', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      // Create contract with script acceptance (triggers async background acceptance)
      const contractId = await testManager.create(makeContractYaml({
        title: 'Async Acceptance Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'script', script_file: 'acceptance/t1.sh' },
        ],
      }));

      // Create the script file so acceptance config resolves
      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.sh'), '#!/bin/sh\nexit 0', { mode: 0o755 });

      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      expect(result.async).toBe(true);

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_STARTED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
      );
    });

    it('writes CONTRACT_UPDATED audit on subtask completion', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Contract Updated Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [],
      }));

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.UPDATED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
        expect.stringContaining('status=completed'),
      );
    });
  });

  describe('fire-and-forget 失败状态机（phase 468 / feedback driven）', () => {
    it('LLM judged failed → cause=llm_rejected + reset todo + retry_count++', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.prompt.txt'), 'Check: {{evidence}}');

      vi.spyOn(testManager as any, 'runLLMAcceptance').mockResolvedValue({
        passed: false,
        feedback: 'LLM says no',
      });

      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      expect(result.async).toBe(true);

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBe(1);
      expect(progress.subtasks['t1'].last_failed_feedback).toEqual({
        feedback: 'LLM says no',
        cause: 'llm_rejected',
      });
    });

    it('programming bug throw → cause=programming_bug + reset todo', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.prompt.txt'), 'Check');

      vi.spyOn(testManager as any, 'runLLMAcceptance').mockRejectedValue(
        new TypeError('undefined is not a function')
      );

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('programming_bug');
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('system bug');

      const unexpectedThrowCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW
      );
      expect(unexpectedThrowCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(unexpectedThrowCalls[0][4]).toContain('TypeError');
    });

    it('subagent timeout → cause=subagent_timeout + reset todo', async () => {
      const { ToolTimeoutError } = await import('../../src/foundation/errors.js');
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.prompt.txt'), 'Check');

      vi.spyOn(testManager as any, 'runLLMAcceptance').mockRejectedValue(
        new ToolTimeoutError('verifier', 5000)
      );

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('subagent_timeout');
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('5000');
    });

    it('onNotify acceptance_failed payload schema = AcceptanceFailedNotification', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());
      const onNotifySpy = vi.fn();
      testManager.setOnNotify(onNotifySpy);

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.prompt.txt'), 'Check');

      vi.spyOn(testManager as any, 'runLLMAcceptance').mockResolvedValue({
        passed: false,
        feedback: 'rejected by LLM',
      });

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const notifyCall = onNotifySpy.mock.calls.find(
        (call: any[]) => call[0] === 'acceptance_failed'
      );
      expect(notifyCall).toBeDefined();
      const payload = notifyCall![1];
      expect(payload).toMatchObject({
        contract_id: contractId,
        subtask_id: 't1',
        cause: 'llm_rejected',
        feedback: 'rejected by LLM',
        retry_count: 1,
        max_retries: 3,
      });
    });

    it('max_retries 后 subtask 仍 todo（不进 failed）', async () => {
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'script', script_file: 'acceptance/t1.sh' },
        ],
        escalation: { max_retries: 2 },
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'acceptance', 't1.sh'), 0o755);

      vi.spyOn(testManager as any, 'runScriptAcceptance').mockResolvedValue({
        passed: false,
        feedback: 'acceptance failed',
      });

      for (let i = 0; i < 3; i++) {
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await waitFor(
          async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
          5000,
          10,
        );
      }

      // Escalation saveProgress runs after inbox write; poll for escalated_at
      await waitFor(
        async () => Boolean((await testManager.getProgress(contractId)).subtasks['t1'].escalated_at),
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      // phase 1102 con-4: status becomes 'escalated' (not 'failed') after max retries
      expect(progress.subtasks['t1'].status).toBe('escalated');
      expect(progress.subtasks['t1'].status).not.toBe('failed');
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].escalated_at).toBeDefined();

      const escalationCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ESCALATED
      );
      expect(escalationCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(escalationCalls[0]).toEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.ESCALATED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
      ]));
    });

    it('retry_count 跨多次失败递增', async () => {
      const { ToolTimeoutError } = await import('../../src/foundation/errors.js');
      const mockAudit = { write: vi.fn() };
      const testManager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        acceptance: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'acceptance', 't1.prompt.txt'), 'Check');

      let spy = vi.spyOn(testManager as any, 'runLLMAcceptance').mockResolvedValueOnce({
        passed: false,
        feedback: 'first reject',
      });
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done1' });
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMAcceptance').mockRejectedValueOnce(
        new Error('bug')
      );
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done2' });
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMAcceptance').mockRejectedValueOnce(
        new ToolTimeoutError('verifier', 3000)
      );
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done3' });
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );
      spy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('subagent_timeout');
    });
  });
});
