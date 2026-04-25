/**
 * done tool 测试 — allCompleted 分支 (Phase 22 C1+C2)
 *
 * 测试 done.ts 中：
 * - result.allCompleted=true → "All subtasks complete!" (不再查 loadActive)
 * - result.allCompleted=false → 显示剩余列表
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { doneTool } from '../../src/core/tools/builtins/done.js';
import { ContractManager } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import * as os from 'os';

let testDir: string;
let clawDir: string;

/** 最小 ExecContext */
function makeCtx() {
  return {
    clawId: 'test-claw',
    clawDir: clawDir,
  } as any;
}

describe('doneTool', () => {
  let manager: ContractManager;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-done-tool-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir, enforcePermissions: false });
    const mockAudit = { write: vi.fn() };
    manager = new ContractManager(clawDir, 'test-claw', nodeFs, mockAudit as any);
    doneTool.contractManager = manager;
  });

  afterEach(() => {
    doneTool.contractManager = undefined;
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should return "All subtasks complete!" when last subtask accepted', async () => {
    // 单子任务契约，无 acceptance 脚本 → 直接通过
    await manager.create({
      schema_version: 1 as const,
      title: 'Single Task Contract',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'Task One' }],
      acceptance: [],
      auth_level: 'auto' as const,
    });

    const ctx = makeCtx();
    const result = await doneTool.execute({ subtask: 't1', evidence: 'done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('All subtasks complete!');
  });

  it('should show remaining subtask list (not allCompleted) when subtasks remain', async () => {
    await manager.create({
      schema_version: 1 as const,
      title: 'Multi Task Contract',
      goal: 'Test',
      deliverables: [],
      subtasks: [
        { id: 't1', description: 'Task One' },
        { id: 't2', description: 'Task Two' },
      ],
      acceptance: [],
      auth_level: 'auto' as const,
    });

    const ctx = makeCtx();
    const result = await doneTool.execute({ subtask: 't1', evidence: 'done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).not.toContain('All subtasks complete!');
    // 剩余任务列表应包含 t2
    expect(result.content).toContain('t2');
    expect(result.content).toContain('Task Two');
  });

  it('should return error when doneTool.contractManager not injected', async () => {
    doneTool.contractManager = undefined;
    const result = await doneTool.execute({ subtask: 't1', evidence: 'done' }, {} as any);
    expect(result.success).toBe(false);
    expect(result.content).toContain('No contract manager');
  });

  it('should return error when no active contract', async () => {
    // ContractManager exists but no contract created
    const ctx = makeCtx();
    const result = await doneTool.execute({ subtask: 't1', evidence: 'done' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('No active contract');
  });

  it('should return failure when subtaskId is unknown', async () => {
    await manager.create({
      schema_version: 1 as const,
      title: 'Test Contract',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'Task One' }],
      acceptance: [],
      auth_level: 'auto' as const,
    });

    const ctx = makeCtx();
    const result = await doneTool.execute({ subtask: 'nonexistent', evidence: 'done' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('rejected');
  });
});
