/**
 * ContractSystem contract/subtask shape validation tests (phase 1331 split)
 *
 * Extracted from contract_manager-escalation.test.ts:229-299 (Contract shape after field removal Step 44).
 * These 4 tests don't trigger spawn or LOCK retry paths — runs in fast project without vi.mock.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';

let testDir: string;
let clawDir: string;

describe('ContractSystem - Contract shape after field removal (Step 44)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-shape-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });
  });

  const minimalYaml = makeContractYaml({
    title: 'Shape Test',
    goal: 'Verify contract shape',
    subtasks: [
      { id: 'st-1', description: 'Subtask 1' },
      { id: 'st-2', description: 'Subtask 2' },
    ],
    verification: [
      { subtask_id: 'st-1', type: 'script', script_file: 'verification/st-1.sh' },
      { subtask_id: 'st-2', type: 'script', script_file: 'verification/st-2.sh' },
    ],
  });

  it('loadActive() 返回的 Contract 不含已删字段', async () => {
    await manager.create(minimalYaml);
    const contract = await manager.loadActive();
    expect(contract).not.toBeNull();

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
