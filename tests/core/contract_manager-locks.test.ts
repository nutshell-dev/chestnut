/**
 * ContractSystem lock retry tests (phase 1351 split)
 *
 * Extracted from contract_manager.test.ts:337-484 (4 lock retry tests).
 * These tests require vi.mock for constants.js (LOCK_MAX_RETRIES=3 override) → stays isolated.
 * Remaining contract_manager.test.ts becomes mock-free → moves to fast project.
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
import { makeMockAudit } from '../helpers/audit.js';

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

describe('ContractSystem - lock retry (phase 1351 split)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-locks-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });
  });

  // === Phase 22 H1: acquireLock EEXIST retry ===

  it('should acquire lock after EEXIST retry when lock is released mid-wait', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Lock Retry Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
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
      verification: [],
    }));

    // 写入锁文件（持有者 = 当前进程，模拟活跃锁），不释放
    const lockPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, time: Date.now() }), 'utf-8');

    await expect(manager.pause(contractId, 'checkpoint'))
      .rejects.toThrow(/Failed to acquire lock after/);
  }, 2000);

  it('should audit cleanup failure when unlinking stale lock fails (EACCES)', async () => {
    const mockAudit = makeMockAudit();
    const testManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit,
      toolRegistry: createToolRegistry(),
      fsFactory
    });

    const contractId = await testManager.create(makeContractYaml({
      title: 'Lock Cleanup AuditLog',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
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
    const mockAudit = makeMockAudit();
    const testManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit,
      toolRegistry: createToolRegistry(),
      fsFactory
    });

    const contractId = await testManager.create(makeContractYaml({
      title: 'Lock Cleanup ENOENT',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
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

  // Note: runScriptVerification tests removed - implementation now uses execFile (async)
  // New tests for async script verification should be added in future phases

  // === Phase 22 C1+C2: completeSubtask allCompleted path ===

});
