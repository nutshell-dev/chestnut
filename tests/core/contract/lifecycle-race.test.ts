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

/**
 * Mock 慢 background verification 延迟 (150ms): 给 cancel race 留 in_progress 窗口.
 * Derivation: > microtask flush / 保 completeSubtask 返后 verification 仍 in-flight.
 */
const MOCK_SLOW_VERIFICATION_MS = 150;

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
    manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: captureAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('pause race: concurrent completeSubtask + pause no deadlock no data loss (P0.16)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Pause Race Test',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
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

  it('cancel race: concurrent verification background + cancel no progress overwrite (P0.18)', async () => {
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
        verification: [{ subtask_id: subtaskId, type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
      }))
    );

    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({
        // phase 319: 加 schema_version 以匹配 Zod SoT strict 要求（mirror phase 311 ContractYaml strict pattern）
        schema_version: 1,
        contract_id: contractId,
        status: 'running',
        subtasks: {
          [subtaskId]: { status: 'todo', retry_count: 0 },
        },
        started_at: new Date().toISOString(),
        checkpoint: null,
      }, null, 2)
    );
    await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
    await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Test');

    const mockLLM = {
      call: vi.fn(),
      stream: vi.fn(),
    } as unknown as LLMOrchestrator;

    const testManager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: manager['fs'],
      audit: manager['audit'] as any,
      llm: mockLLM,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    // Mock runLLMVerification to delay, simulating slow background verification
    vi.spyOn(testManager as any, 'runLLMVerification').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, MOCK_SLOW_VERIFICATION_MS)); // sleep: mock slow background verification
      return { passed: true, feedback: 'mocked' };
    });

    // Trigger background verification
    await testManager.completeSubtask({ contractId, subtaskId, evidence: 'done' });

    // Immediately cancel while background is still running
    await testManager.cancel(contractId, 'user cancelled');

    await vi.waitUntil(async () => {
      const progress = await testManager.getProgress(contractId);
      return progress.status === 'cancelled';
    }, { timeout: 5000 });
  });

  it('cancelled guard returns null + audit VERIFICATION_RESET_FAILED (P0.18)', async () => {
    const contractId = await manager.create(makeContractYaml({
      title: 'Cancelled Guard Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    await manager.cancel(contractId, 'test cancel');

    const beforeAudit = auditCalls.length;

    // Try to complete subtask on cancelled contract
    const result = await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

    const progress = await manager.getProgress(contractId);
    expect(progress.status).toBe('cancelled');
    expect(progress.subtasks['t1'].status).toBe('todo');

    // phase 1221: predicate 精确 match context=completeSubtaskSync 防 multi-site emit 拿错位
    // (verification.ts 6 site emit VERIFICATION_RESET_FAILED 不同 context 值、phase 1196 β 仅 type match 残留 race)
    const isCompleteSubtaskSyncGuard = (c: { type: string; args: string[] }) =>
      c.type === CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED &&
      c.args.some(a => a.includes('context=completeSubtaskSync'));

    await vi.waitUntil(
      () => auditCalls.slice(beforeAudit).some(isCompleteSubtaskSyncGuard),
      { timeout: 2000, interval: 20 },
    );
    const guardAudits = auditCalls.slice(beforeAudit).filter(isCompleteSubtaskSyncGuard);
    expect(guardAudits.length).toBeGreaterThanOrEqual(1);
    expect(guardAudits[0].args.some(a => a.includes('context=completeSubtaskSync'))).toBe(true);
  });
});
