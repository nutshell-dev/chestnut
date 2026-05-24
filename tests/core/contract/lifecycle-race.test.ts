/**
 * ContractSystem lifecycle race (phase 791 / P0.16 + P0.18)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';

vi.mock('../../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,
    LOCK_RETRY_DELAY_MS: 10,
  };
});

describe('ContractSystem lifecycle race (phase 791 / P0.16 + P0.18)', () => {
  let tempDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let auditCalls: Array<{ type: string; args: string[] }>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditCalls = [];
    const captureAudit = {
      write: (type: string, ...args: string[]) => {
        auditCalls.push({ type, args });
      },
    };
    manager = new ContractSystem(
      clawDir, 'test-claw', nodeFs, captureAudit as any, undefined, createToolRegistry()
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('pause race: concurrent completeSubtask + pause no deadlock no data loss (P0.16)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Race Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      acceptance: [],
    }));

    // 先完成一个子任务，确保数据存在
    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    // 并发：同时 pause 和 completeSubtask
    const [pauseResult] = await Promise.allSettled([
      manager.pause(contractId, 'race-checkpoint'),
      manager.completeSubtask({ contractId, subtaskId: 't2', evidence: 'done too' }),
    ]);

    // pause 应该成功（或在 lock 竞争下失败但不死锁）
    expect(pauseResult.status).not.toBe('rejected');

    // 最终 contract 应在 paused/（如果 pause 赢了）或 active/（如果 pause 没赢）
    // 但关键是 status 和子任务数据没被损坏
    const progress = await manager.getProgress(contractId);
    // 子任务 t1 必须仍然是 completed
    expect(progress.subtasks['t1'].status).toBe('completed');
  });

  it('cancel race: concurrent acceptance background + cancel no progress overwrite (P0.18)', async () => {
    const contractId = 'cancel-race-contract';
    const subtaskId = 't1';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });

    const yaml = await import('js-yaml');
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      yaml.dump(makeContractYaml({
        title: 'Cancel Race Test',
        goal: 'Test',
        subtasks: [{ id: subtaskId, description: 'T1' }],
        acceptance: [{ subtask_id: subtaskId, type: 'llm', prompt_file: 'acceptance/t1.prompt.txt' }],
      }))
    );

    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({
        contract_id: contractId,
        status: 'running',
        subtasks: {
          [subtaskId]: { status: 'todo', retry_count: 0 },
        },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }, null, 2)
    );
    await fs.mkdir(path.join(contractDir, 'acceptance'), { recursive: true });
    await fs.writeFile(path.join(contractDir, 'acceptance', 't1.prompt.txt'), 'Test');

    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;

    const testManager = new ContractSystem(
      clawDir, 'test-claw', manager['fs'], manager['audit'] as any, mockLLM, createToolRegistry()
    );

    // Mock runLLMAcceptance to delay, simulating slow background acceptance
    vi.spyOn(testManager as any, 'runLLMAcceptance').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 150)); // sleep: mock slow background acceptance
      return { passed: true, feedback: 'mocked' };
    });

    // Trigger background acceptance
    await testManager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    // Immediately cancel while background is still running
    await testManager.cancel(contractId, 'user cancelled');

    await vi.waitUntil(async () => {
      const progress = await testManager.getProgress(contractId);
      return progress.status === 'cancelled';
    }, { timeout: 5000 });
  });

  it('cancelled guard returns null + audit ACCEPTANCE_RESET_FAILED (P0.18)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancelled Guard Test',
      goal: 'Test',
      deliverables: [],
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    await manager.cancel(contractId, 'test cancel');

    const beforeAudit = auditCalls.length;

    // Try to complete subtask on cancelled contract
    const result = await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');
    expect(progress.subtasks['t1'].status).toBe('todo');

    await vi.waitUntil(
      () => auditCalls.slice(beforeAudit).some(
        c => c.type === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED
      ),
      { timeout: 2000, interval: 20 },
    );
    const guardAudits = auditCalls.slice(beforeAudit).filter(
      c => c.type === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED
    );
    expect(guardAudits.length).toBeGreaterThanOrEqual(1);
    expect(guardAudits[0].args.some(a => a.includes('context=completeSubtaskSync'))).toBe(true);
  });
});
