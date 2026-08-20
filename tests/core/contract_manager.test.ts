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
import { ContractValidationError, ContractArchiveReadError } from '../../src/core/contract/errors.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createContextInjector } from '../../src/core/runtime/injector.js';
import { computeContractView } from '../../src/core/status-service/aggregators.js';


import { DEAD_PID } from '../helpers/dead-pid.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';
import { completeSubtask } from '../helpers/contract-subtask.js';
// phase 1351: vi.mock(child_process) removed (was no-op passthrough)

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

  it('create publishes by removing .creating marker (Phase 1197 Step B)', async () => {
    const contractId = await manager.create(makeContractYaml({
      id: 'published-markerless',
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(path.join(activeDir, 'contract.yaml'))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, 'progress.json'))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, '.creating'))).rejects.toThrow();
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

  it('returns already_committed when cancelling already cancelled contract', async () => {
    const contractYaml = makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    });

    const contractId = await manager.create(contractYaml);
    const first = await manager.cancel(contractId, 'Cancel');
    expect(first.kind).toBe('committed');

    // Phase 1198 Step C: idempotent retry returns already_committed, not an error.
    const second = await manager.cancel(contractId, 'Cancel again');
    expect(second.kind).toBe('already_committed');
    expect(second.state).toBe('cancelled');
  });

  // === Phase 1194 Step B: multiple active create ===

  it('should allow second create while another active exists and preserve both', async () => {
    const contract1 = await manager.create(makeContractYaml({
      id: 'first-active',
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const activePath = path.join(clawDir, 'contract', 'active', contract1);
    const yamlBefore = await fs.readFile(path.join(activePath, 'contract.yaml'), 'utf-8');
    const progressBefore = await fs.readFile(path.join(activePath, 'progress.json'), 'utf-8');

    const contract2 = await manager.create(makeContractYaml({
      id: 'second-active',
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }));

    // first active contract unchanged byte-for-byte
    expect(await fs.readFile(path.join(activePath, 'contract.yaml'), 'utf-8')).toBe(yamlBefore);
    expect(await fs.readFile(path.join(activePath, 'progress.json'), 'utf-8')).toBe(progressBefore);

    // second active directory created
    expect(await nodeFs.exists('contract/active/second-active')).toBe(true);

    // loadActive returns foreground (earliest started_at)
    const active = await manager.loadActive();
    expect(active?.id).toBe(contract1);
  });

  it('should reject create with duplicate id across active contracts', async () => {
    await manager.create(makeContractYaml({
      id: 'shared-id',
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await expect(manager.create(makeContractYaml({
      id: 'shared-id',
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }))).rejects.toBeInstanceOf(ContractValidationError);
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
    await completeSubtask(manager, { contractId, subtaskId: 'task-1', evidence: 'Task completed' });

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
    const result = await completeSubtask(manager, { 
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
    const first = await completeSubtask(manager, { contractId, subtaskId: 'task-1', evidence: 'done' });
    expect(first.passed).toBe(true);

    // Second call on already-completed subtask: should return error feedback
    const second = await completeSubtask(manager, { contractId, subtaskId: 'task-1', evidence: 'done again' });
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
    await completeSubtask(manager, { contractId, subtaskId: 'task-1', evidence: 'Task 1 done' });
    await completeSubtask(manager, { contractId, subtaskId: 'task-2', evidence: 'Task 2 done' });

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('completed');
  });

  it('returns already_committed when retrying cancel on a cancelled contract', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // Phase 1198 Step C: idempotent retry returns already_committed, not an error.
    await manager.cancel(contractId, 'Cancelled');
    const outcome = await manager.cancel(contractId, 'Try cancel again');
    expect(outcome.kind).toBe('already_committed');
    expect(outcome.state).toBe('cancelled');
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

    const result = await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });

    expect(result.passed).toBe(true);
    expect(result.allCompleted).toBe(true);

    // 契约已移入 archive/completed（active/ 目录不再存在）
    const archivePath = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await expect(fs.access(archivePath)).resolves.not.toThrow();
    const activePath = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(activePath)).rejects.toThrow();

    // phase 738: contract_completed notify emitted on archive success
    // phase 1260 Step A: typed event 精确断言（含 subtasks summary / completedAt）
    const completedEvents = onNotifySpy.mock.calls.filter(
      (call: any[]) => call[0].type === 'contract_completed'
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0][0]).toEqual({
      type: 'contract_completed',
      contractId,
      title: 'AllCompleted Test',
      goal: 'Test',
      subtasks: [{ id: 't1', completedAt: expect.any(String), forceAccepted: false }],
      completedAt: expect.any(String),
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

    const result = await completeSubtask(manager, { contractId, subtaskId: 't1', evidence: 'done' });

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

  // === Phase 1194 Step C: foreground propagation and hand-off ===

  describe('foreground propagation (phase 1194 Step C)', () => {
    async function createWithStartedAt(
      contractSystem: ContractSystem,
      id: string,
      startedAt: string,
      title: string,
    ) {
      const contractId = await contractSystem.create(makeContractYaml({
        id,
        title,
        goal: title,
        subtasks: [{ id: 't1', description: `${title} task` }],
        verification: [],
      }));
      // Override started_at so the test controls FIFO order deterministically.
      const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      progress.started_at = startedAt;
      await fs.writeFile(progressPath, JSON.stringify(progress, null, 2), 'utf-8');
      return contractId;
    }

    it('ContextInjector, status aggregator and submit tool all observe the same foreground', async () => {
      const older = await createWithStartedAt(manager, 'older', '2026-07-12T10:00:00.000Z', 'Older Contract');
      const newer = await createWithStartedAt(manager, 'newer', '2026-07-12T11:00:00.000Z', 'Newer Contract');

      // ContractSystem.loadActive is the single source of foreground.
      const active = await manager.loadActive();
      expect(active?.id).toBe(older);
      expect(active?.title).toBe('Older Contract');

      // ContextInjector injects only the foreground contract.
      const injector = createContextInjector({ fs: nodeFs, loadActiveContract: () => manager.loadActive() });
      const parts = await injector.buildParts();
      expect(parts.contract).toContain('Older Contract');
      expect(parts.contract).not.toContain('Newer Contract');

      // Status aggregator shows the same foreground.
      const view = await computeContractView(manager);
      expect(view.type).toBe('active');
      if (view.type === 'active') {
        expect(view.title).toBe('Older Contract');
      }

      // submit_subtask tool targets the foreground contract.
      const tool = manager.createSubmitSubtaskTool();
      const result = await tool.execute({ subtask: 't1', evidence: 'done' }, {} as any);
      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({ contractId: older });
      expect(result.metadata).not.toMatchObject({ contractId: newer });
    });

    it('foreground switches to next contract after the current one is cancelled', async () => {
      const older = await createWithStartedAt(manager, 'older', '2026-07-12T10:00:00.000Z', 'Older Contract');
      await createWithStartedAt(manager, 'newer', '2026-07-12T11:00:00.000Z', 'Newer Contract');

      expect((await manager.loadActive())?.id).toBe(older);

      await manager.cancel(older, 'release foreground');

      const next = await manager.loadActive();
      expect(next?.id).toBe('newer');
      expect(next?.title).toBe('Newer Contract');

      const injector = createContextInjector({ fs: nodeFs, loadActiveContract: () => manager.loadActive() });
      const parts = await injector.buildParts();
      expect(parts.contract).toContain('Newer Contract');
      expect(parts.contract).not.toContain('Older Contract');
    });

    it('foreground switches to next contract after the current one completes', async () => {
      const older = await createWithStartedAt(manager, 'older', '2026-07-12T10:00:00.000Z', 'Older Contract');
      await createWithStartedAt(manager, 'newer', '2026-07-12T11:00:00.000Z', 'Newer Contract');

      await completeSubtask(manager, { contractId: older, subtaskId: 't1', evidence: 'done' });

      const next = await manager.loadActive();
      expect(next?.id).toBe('newer');
    });

    it('does not let a newly created contract preempt an earlier foreground', async () => {
      const first = await createWithStartedAt(manager, 'first', '2026-07-12T09:00:00.000Z', 'First Contract');
      await createWithStartedAt(manager, 'second', '2026-07-12T10:00:00.000Z', 'Second Contract');
      await createWithStartedAt(manager, 'third', '2026-07-12T11:00:00.000Z', 'Third Contract');

      expect((await manager.loadActive())?.id).toBe(first);
    });
  });
});
