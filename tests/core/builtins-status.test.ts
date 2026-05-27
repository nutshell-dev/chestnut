/**
 * Builtin status tool tests (phase 1340 split)
 *
 * Extracted from builtins.test.ts:683-977 (status tool describe).
 * status tool tests don't use spawn / vi.mock → fast project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createStatusTool } from '../../src/core/status-service/index.js';
import { createClawPermissionChecker } from '../../src/core/permissions/claw-permissions.js';
import { ExecContextImpl } from '../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { OutboxWriter } from '../../src/foundation/messaging/index.js';
import { createOutboxWriter } from '../../src/foundation/messaging/index.js';
import { makeAudit, makeMockAudit } from '../helpers/audit.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { TASKS_QUEUES_RUNNING_DIR } from '../../src/core/async-task-system/index.js';

describe('Builtin Tools - status tool', () => {
  let tempDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
  let mockFs: NodeFileSystem;
  let ctx: ExecContextImpl;
  let outboxWriter: OutboxWriter;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = await createTempDir();
    await fs.mkdir(path.join(tempDir, 'clawspace'), { recursive: true });
    mockFs = new NodeFileSystem({ baseDir: tempDir });
    outboxWriter = createOutboxWriter('test-claw', tempDir, mockFs, makeAudit().audit);
    ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir: tempDir,
      syncDir: path.join(tempDir, 'tasks', 'sync'),
      profile: 'full',
      fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('status tool', () => {
    let statusTool = createStatusTool({ loadActive: vi.fn().mockResolvedValue(null) } as any);

    it('schema has 0 properties and supportsAsync is false (phase 555 cross-check)', () => {
      expect(Object.keys(statusTool.schema.properties)).toEqual([]);
      expect(statusTool.supportsAsync).toBe(false);
    });

    it('should return status information', async () => {
      const result = await statusTool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Claw ID: test-claw');
      expect(result.content).toContain('Profile: full');
      expect(result.content).toContain('Step:');
      expect(result.content).toContain('Elapsed:');
    });

    it('should show "No active contract" when contractManager has no active contract', async () => {
      const mockAudit = makeMockAudit();
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory
      });
      const statusTool = createStatusTool(manager);

      const result = await statusTool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('No active contract');
    });

    it('should show subtask list with ○ icons when contract is active', async () => {
      const mockAudit = makeMockAudit();
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory
      });
      await manager.create(makeContractYaml({
        title: 'Test Contract',
        goal: 'Test',
        deliverables: [],
        subtasks: [
          { id: 'task-1', description: 'First task' },
          { id: 'task-2', description: 'Second task' },
        ],
        verification: [],
      }));
      const statusTool = createStatusTool(manager);

      const result = await statusTool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Test Contract');
      expect(result.content).toContain('0/2 subtasks done');
      // Phase 21 Step 3: 逐行显示子任务
      expect(result.content).toContain('○ task-1: First task');
      expect(result.content).toContain('○ task-2: Second task');
    });

    it('should show ✓ for completed subtask and ○ for todo subtask', async () => {
      const mockAudit = makeMockAudit();
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory
      });
      const contractId = await manager.create(makeContractYaml({
        title: 'Mixed Status',
        goal: 'Test',
        deliverables: [],
        subtasks: [
          { id: 'done-task', description: 'Already done' },
          { id: 'todo-task', description: 'Still pending' },
        ],
        verification: [],
      }));
      // 完成第一个子任务（无 verification 脚本，直接通过）
      await manager.completeSubtask({ contractId, subtaskId: 'done-task', evidence: 'done' });
      const statusTool = createStatusTool(manager);

      const result = await statusTool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('✓ done-task: Already done');
      expect(result.content).toContain('○ todo-task: Still pending');
      expect(result.content).toContain('1/2 subtasks done');
    });

    // MEMORY.md 不存在
    it('should show MEMORY.md Not found when file does not exist', async () => {
      const result = await statusTool.execute({}, ctx);
      expect(result.success).toBe(true);
      expect(result.content).toContain('MEMORY.md: Not found');
    });

    // MEMORY.md 读取异常
    it('should show MEMORY.md Error when fs.read throws', async () => {
      await mockFs.writeAtomic('MEMORY.md', 'some content');
      const readSpy = vi.spyOn(mockFs, 'read').mockRejectedValueOnce(
        Object.assign(new Error('disk error'), { code: 'EIO' })
      );
      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('MEMORY.md: Error');
      expect(result.content).toContain('disk error');
      readSpy.mockRestore();
    });

    // clawspace ENOENT → 0 files
    it('should show Clawspace 0 files when clawspace dir does not exist', async () => {
      // tempDir 内无 clawspace 目录，list 会抛 ENOENT
      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('Clawspace: 0 files');
    });

    // clawspace 非 ENOENT 异常
    it('should show Clawspace Error when non-ENOENT error occurs', async () => {
      await mockFs.ensureDir('clawspace');
      const listSpy = vi.spyOn(mockFs, 'list').mockImplementation(async (target: string) => {
        if (target === 'clawspace') {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return [];
      });
      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('Clawspace: Error');
      expect(result.content).toContain('permission denied');
      listSpy.mockRestore();
    });

    // contractManager.loadActive 抛异常
    it('should show Contract Error loading when loadActive throws', async () => {
      const statusTool = createStatusTool({
        loadActive: vi.fn().mockRejectedValue(new Error('corrupted yaml')),
      } as any);
      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('Contract: Error loading');
    });

    // 先找文件顶部的 import 部分来加

    // subtask failed 状态显示 ✗
    it('should show ✗ icon for failed subtask', async () => {
      const mockAudit = makeMockAudit();
      const manager = new ContractSystem({
        clawDir: tempDir,
        clawId: 'test-claw',
        fs: mockFs,
        audit: mockAudit as any,
        toolRegistry: createToolRegistry(),
        fsFactory
      });
      const contractId = await manager.create({
        title: 'Fail Test',
        goal: 'test',
        subtasks: [
          { id: 'fail-task', description: 'This will fail' },
          { id: 'ok-task', description: 'This is ok' },
        ],
        verification: [],
        deliverables: [],
      });
      // 直接修改 progress.json 设置 failed 状态
      const progressPath = path.join(tempDir, 'contract/active', contractId, 'progress.json');
      const raw = await fs.readFile(progressPath, 'utf-8');
      const progress = JSON.parse(raw);
      progress.subtasks['fail-task'].status = 'failed';
      await fs.writeFile(progressPath, JSON.stringify(progress));

      const statusTool = createStatusTool(manager);
      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('✗ fail-task');
      expect(result.content).toContain('○ ok-task');
    });

    // task running + pending
    it('should show running and pending task counts', async () => {
      await mockFs.ensureDir('tasks/queues/pending');
      await mockFs.ensureDir(TASKS_QUEUES_RUNNING_DIR);
      await mockFs.writeAtomic('tasks/queues/pending/t1.json', '{}');
      await mockFs.writeAtomic('tasks/queues/running/t2.json', '{}');

      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('1 running, 1 pending');
    });

    // 只有 pending
    it('should show only pending task count when no running tasks', async () => {
      await mockFs.ensureDir('tasks/queues/pending');
      await mockFs.writeAtomic('tasks/queues/pending/t1.json', '{}');
      await mockFs.writeAtomic('tasks/queues/pending/t2.json', '{}');

      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('2 pending');
    });

    // tasks/queues/pending 不存在 → silent (ENOENT is expected for fresh setup)
    it('should treat pending count as 0 when tasks/queues/pending does not exist', async () => {
      const result = await statusTool.execute({}, ctx);
      expect(result.content).toContain('Tasks: idle');
      // ENOENT is now silently ignored (expected for fresh setup)
    });

    // AuditLog event tests for status tool error paths
    it('should audit STATUS_CONTRACT_ERROR when loadActive throws', async () => {
      const auditWriter = makeMockAudit();
      const ctxWithAudit = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        auditWriter: auditWriter as any,
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });
      const statusTool = createStatusTool({
        loadActive: vi.fn().mockRejectedValue(new Error('yaml parse error')),
      } as any);

      await statusTool.execute({}, ctxWithAudit);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'status_contract_error',
        'error=yaml parse error',
      );
    });

    it('should audit STATUS_TASK_PENDING_ERROR when pending list fails non-ENOENT', async () => {
      const auditWriter = makeMockAudit();
      const listSpy = vi.spyOn(mockFs, 'list').mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
      const ctxWithAudit = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        auditWriter: auditWriter as any,
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });
      await statusTool.execute({}, ctxWithAudit);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'status_task_pending_error',
        'error=permission denied',
      );

      listSpy.mockRestore();
    });

    it('should audit STATUS_TASK_RUNNING_ERROR when running list fails non-ENOENT', async () => {
      const auditWriter = makeMockAudit();
      // First call (pending) succeeds, second call (running) fails
      let callCount = 0;
      const listSpy = vi.spyOn(mockFs, 'list').mockImplementation(async (...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          return []; // pending succeeds
        }
        throw Object.assign(new Error('disk error'), { code: 'EIO' });
      });
      const ctxWithAudit = new ExecContextImpl({
        clawId: 'test-claw',
        clawDir: tempDir,
        profile: 'full',
        fs: mockFs,
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
        auditWriter: auditWriter as any,
        permissionChecker: createClawPermissionChecker({ clawDir: tempDir, strict: true }),
      });
      await statusTool.execute({}, ctxWithAudit);

      expect(auditWriter.write).toHaveBeenCalledWith(
        'status_task_running_error',
        'error=disk error',
      );

      listSpy.mockRestore();
    });

  });


});
