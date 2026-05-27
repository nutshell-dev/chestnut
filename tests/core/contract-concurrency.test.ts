/**
 * ContractSystem — 并发幂等 + 锁机制测试
 *
 * 覆盖：
 * - 并发 completeSubtask() 同一 subtask 的幂等保护
 * - 重复调用的状态守卫（in_progress / completed）
 * - 未知 subtaskId 错误处理
 * - Stale lock（持有者进程已死）自动恢复
 * - Corrupt lock（JSON 损坏）自动恢复
 */

import { makeContractYaml } from '../helpers/contract-yaml.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { DEAD_PID } from '../helpers/dead-pid.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

// 无验收配置（completeSubtask 同步完成，锁定时间极短，适合并发测试）
const BASE_YAML = makeContractYaml({
  title: 'Concurrency Test',
  goal: 'Test concurrency guard',
  subtasks: [
    { id: 'st-a', description: 'Subtask A' },
    { id: 'st-b', description: 'Subtask B' },
  ],
  // 无 verification：走 _completeSubtaskSync 路径
  verification: [],
});

describe('ContractSystem — 并发幂等与锁', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `clawforum-concurrency-${randomUUID()}`);
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = { write: vi.fn() };
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // =========================================================================
  // 重复 done() 状态守卫
  // =========================================================================

  it('已完成的 subtask 再次 done() 返回 guard 信息而非报错', async () => {
    const contractId = await manager.create(BASE_YAML);

    // 第一次：应成功
    const first = await manager.completeSubtask({
      contractId,
      subtaskId: 'st-a',
      evidence: 'First call',
    });
    expect(first.passed).toBe(true);

    // 第二次：subtask 已 completed，应返回 guard 信息
    const second = await manager.completeSubtask({
      contractId,
      subtaskId: 'st-a',
      evidence: 'Duplicate call',
    });
    expect(second.passed).toBe(false);
    expect(second.feedback).toMatch(/already completed/i);
  });

  it('并发 completeSubtask() 同一 subtask 只成功一次', async () => {
    const contractId = await manager.create(BASE_YAML);

    // 两个并发调用，锁保证只有一个先写 completed
    const [r1, r2] = await Promise.all([
      manager.completeSubtask({ contractId, subtaskId: 'st-a', evidence: 'call-1' }),
      manager.completeSubtask({ contractId, subtaskId: 'st-a', evidence: 'call-2' }),
    ]);

    const successes = [r1, r2].filter(r => r.passed).length;
    const guarded  = [r1, r2].filter(r => !r.passed).length;

    // 恰好一次成功，一次被幂等守卫拦截
    expect(successes).toBe(1);
    expect(guarded).toBe(1);

    // 最终状态：subtask 完成且 contract 未损坏
    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['st-a'].status).toBe('completed');
  });

  it('不同 subtask 的并发 completeSubtask() 均成功', async () => {
    const contractId = await manager.create(BASE_YAML);

    const [ra, rb] = await Promise.all([
      manager.completeSubtask({ contractId, subtaskId: 'st-a', evidence: 'a done' }),
      manager.completeSubtask({ contractId, subtaskId: 'st-b', evidence: 'b done' }),
    ]);

    expect(ra.passed).toBe(true);
    expect(rb.passed).toBe(true);

    const progress = await manager.getProgress(contractId);
    expect(progress.subtasks['st-a'].status).toBe('completed');
    expect(progress.subtasks['st-b'].status).toBe('completed');
    expect(progress.status).toBe('completed'); // 全完成后 contract 自动完成
  });

  // =========================================================================
  // 未知 subtaskId
  // =========================================================================

  it('未知 subtaskId 返回 passed:false 并列出合法 id', async () => {
    const contractId = await manager.create(BASE_YAML);

    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'nonexistent',
      evidence: 'This should fail',
    });

    expect(result.passed).toBe(false);
    expect(result.feedback).toMatch(/nonexistent/);
    expect(result.feedback).toMatch(/st-a/);
  });

  // =========================================================================
  // Stale lock 恢复
  // =========================================================================

  it('持有者进程已死的 stale lock 被自动清理，操作正常完成', async () => {
    const contractId = await manager.create(BASE_YAML);

    // 确定 lock 路径（contract/active/{contractId}/progress.lock 在 clawDir 内）
    const lockDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'progress.lock');

    // 写入一个不存在的 PID，模拟持有者已死
    const deadPid = DEAD_PID;
    await fs.writeFile(lockPath, JSON.stringify({ pid: deadPid, time: Date.now() }));

    // completeSubtask 应能检测到 stale lock，清理后正常完成
    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'st-a',
      evidence: 'After stale lock recovery',
    });

    expect(result.passed).toBe(true);

    // lock 文件应被清理（不存在）
    const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it('损坏的 lock 文件（invalid JSON）被自动清理，操作正常完成', async () => {
    const contractId = await manager.create(BASE_YAML);

    const lockDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'progress.lock');

    // 写入损坏的 JSON
    await fs.writeFile(lockPath, 'not-valid-json{{{{');

    const result = await manager.completeSubtask({
      contractId,
      subtaskId: 'st-a',
      evidence: 'After corrupt lock recovery',
    });

    expect(result.passed).toBe(true);
  });

  it('writes CONTRACT_LOCK_CLEARED audit when force clearing stale timeout lock', async () => {
    const mockAudit = { write: vi.fn() };
    const auditManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory
    });

    const contractId = await auditManager.create(BASE_YAML);

    const lockDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'progress.lock');

    // 写入当前进程 PID 但时间很久以前，模拟超时锁
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, time: 0 }));

    const result = await auditManager.completeSubtask({
      contractId,
      subtaskId: 'st-a',
      evidence: 'After stale lock force clear',
    });

    expect(result.passed).toBe(true);
    expect(mockAudit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.LOCK_CLEARED,
      `pid=${process.pid}`,
      expect.stringContaining('timeout='),
      'reason=stale',
    );
  });
});
