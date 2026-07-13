/**
 * submit_subtask tool 测试 — allCompleted 分支 (Phase 22 C1+C2)
 *
 * 测试 submit-subtask.ts 中：
 * - result.allCompleted=true → "All subtasks complete!" (不再查 loadActive)
 * - result.allCompleted=false → 显示剩余列表
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createSubmitSubtaskTool } from '../../src/core/contract/index.js';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import * as os from 'os';
import { createToolRegistry } from '../../src/foundation/tools/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let testDir: string;
let clawDir: string;

/** 最小 ExecContext */
function makeCtx() {
  return {
    clawId: 'test-claw',
    clawDir: clawDir,
  } as any;
}

describe('submitSubtaskTool', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let submitSubtaskTool: ReturnType<typeof createSubmitSubtaskTool>;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-submit-subtask-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
    submitSubtaskTool = createSubmitSubtaskTool(manager);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('should return "All subtasks complete!" when last subtask accepted', async () => {
    // 单子任务契约，无 verification 脚本 → 直接通过
    await manager.create(makeContractYaml({
      title: 'Single Task Contract',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'Task One' }],
      verification: [],
    }));

    const ctx = makeCtx();
    const result = await submitSubtaskTool.execute({ subtask: 't1', evidence: 'done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('All subtasks complete!');
  });

  it('should show remaining subtask list (not allCompleted) when subtasks remain', async () => {
    await manager.create(makeContractYaml({
      title: 'Multi Task Contract',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'Task One' },
        { id: 't2', description: 'Task Two' },
      ],
      verification: [],
    }));

    const ctx = makeCtx();
    const result = await submitSubtaskTool.execute({ subtask: 't1', evidence: 'done' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).not.toContain('All subtasks complete!');
    // 剩余任务列表应包含 t2
    expect(result.content).toContain('t2');
    expect(result.content).toContain('Task Two');
  });

  it('should return error when no active contract', async () => {
    // ContractSystem exists but no contract created
    const ctx = makeCtx();
    const result = await submitSubtaskTool.execute({ subtask: 't1', evidence: 'done' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('No active contract');
  });

  it('should return failure when subtaskId is unknown', async () => {
    await manager.create(makeContractYaml({
      title: 'Test Contract',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'Task One' }],
      verification: [],
    }));

    const ctx = makeCtx();
    const result = await submitSubtaskTool.execute({ subtask: 'nonexistent', evidence: 'done' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toContain('rejected');
  });
});
