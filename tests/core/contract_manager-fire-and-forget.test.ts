/**
 * ContractSystem fire-and-forget 失败状态机 tests (phase 468 / feedback driven)
 *
 * phase 1338 split from contract_manager-escalation.test.ts:303-582
 * - 6 tests / fast project / no vi.mock (uses vi.spyOn only)
 * - sequential completeSubtask only — no concurrent lock contention → no LOCK_MAX_RETRIES override needed
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { ToolTimeoutError } from '../../src/foundation/tools/errors.js';  // phase 261: hoist (no vi.mock in this file)
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeAudit, makeMockAudit, waitForAuditEvent, waitForNextAuditEvent } from '../helpers/audit.js';
// phase 1465: _resetVerificationMutexForTest import removed — mutex now instance-bound, per-test fresh ContractSystem 自然提供 fresh mutex

/**
 * Retry exponential backoff base delay (50ms): backoff = base × 2^attempt.
 * Derivation: > microtask flush / 第 1 retry = 50ms / 第 5 retry = 800ms / 总 < 2s budget.
 */
const RETRY_BASE_DELAY_MS = 50;

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Retry completeSubtask on transient mutex race ("already active"),
 * with exponential backoff (50/100/200/400/800ms, 5 attempts).
 */
async function completeSubtaskWithRetry(
  manager: ContractSystem,
  params: { contractId: string; subtaskId: string; evidence: string },
  maxRetries = 5,
): Promise<ReturnType<ContractSystem['completeSubtask']>> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await manager.completeSubtask(params);
    } catch (e: any) {
      if (e?.message?.includes('already active') && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('unreachable');
}

describe('ContractSystem - fire-and-forget 失败状态机 (phase 468 / feedback driven)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-fire-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

    it('LLM judged failed → cause=llm_rejected + reset todo + retry_count++', async () => {
      const { audit: mockAudit, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Check: {{evidence}}');

      vi.spyOn(testManager as any, 'runLLMVerification').mockResolvedValue({
        passed: false,
        feedback: 'LLM says no',
      });

      const verifDoneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      expect(result.async).toBe(true);

      await verifDoneP;

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBe(1);
      expect(progress.subtasks['t1'].last_failed_feedback).toEqual({
        feedback: 'LLM says no',
        cause: 'llm_rejected',
      });
    });

    it('programming bug throw → cause=programming_bug + reset todo', async () => {
      // phase 425: rejection path 用新 SUBTASK_RESET_TO_TODO audit event 替原 waitFor polling
      const { audit: mockAudit, events, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Check');

      vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValue(
        new TypeError('undefined is not a function')
      );

      // phase 425: 必先订阅 SUBTASK_RESET_TO_TODO 再 completeSubtask
      const resetP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO);
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      await resetP;

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('programming_bug');
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('system bug');

      const unexpectedThrowCalls = events.filter(
        (e) => e[0] === CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW
      );
      expect(unexpectedThrowCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(unexpectedThrowCalls[0][4]).toContain('TypeError');
    });

    it('subagent timeout → cause=subagent_timeout + reset todo', async () => {
      // phase 425: rejection path 用新 SUBTASK_RESET_TO_TODO audit event 替原 waitFor polling
      const { audit: mockAudit, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Check');

      vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValue(
        new ToolTimeoutError('verifier', 5000)
      );

      // phase 425: 必先订阅 SUBTASK_RESET_TO_TODO 再 completeSubtask
      const resetP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO);
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      await resetP;

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('subagent_timeout');
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('5000');
    });

    it('onNotify verification_failed payload schema = AcceptanceFailedNotification', async () => {
      const { audit: mockAudit, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
      const onNotifySpy = vi.fn();
      testManager.setOnNotify(onNotifySpy);

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Check');

      vi.spyOn(testManager as any, 'runLLMVerification').mockResolvedValue({
        passed: false,
        feedback: 'rejected by LLM',
      });

      const verifDoneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      await verifDoneP;

      const notifyCall = onNotifySpy.mock.calls.find(
        (call: any[]) => call[0] === 'verification_failed'
      );
      expect(notifyCall).toBeDefined();
      const payload = notifyCall![1];
      expect(payload).toMatchObject({
        contract_id: contractId,
        subtask_id: 't1',
        cause: 'llm_rejected',
        feedback: 'rejected by LLM',
        retry_count: 1,
        max_attempts: 3,
      });
    });

    it('max_attempts 后 subtask force_accepted（status=completed）', async () => {
      const { audit: mockAudit, events, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
        verification_attempts: 2,
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'verification', 't1.sh'), 0o755);

      vi.spyOn(testManager as any, 'runScriptVerification').mockResolvedValue({
        passed: false,
        feedback: 'verification failed',
      });

      for (let i = 0; i < 2; i++) {
        const verifDoneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
        await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await verifDoneP;
      }

      // Force-accept saveProgress runs after inbox write; SUBTASK_FORCE_ACCEPTED 可能已在 2nd 迭代 emit、用 fast-path
      await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);

      const progress = await testManager.getProgress(contractId);
      // After max attempts, subtask is force-accepted (completed, not failed)
      expect(progress.subtasks['t1'].status).toBe('completed');
      expect(progress.subtasks['t1'].status).not.toBe('failed');
      expect(progress.subtasks['t1'].retry_count).toBe(2);
      expect(progress.subtasks['t1'].force_accepted).toBe(true);

      const escalationCalls = events.filter(
        (e) => e[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED
      );
      expect(escalationCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(escalationCalls[0]).toEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
      ]));
    });

    it('retry_count 跨多次失败递增', async () => {
      // phase 425: 3 iter 各独立订阅 SUBTASK_RESET_TO_TODO 替原 waitFor polling
      const { audit: mockAudit, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.prompt.txt'), 'Check');

      let spy = vi.spyOn(testManager as any, 'runLLMVerification').mockResolvedValueOnce({
        passed: false,
        feedback: 'first reject',
      });
      let resetP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO);
      await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: 'done1' });
      await resetP;
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValueOnce(
        new Error('bug')
      );
      resetP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO);
      await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: 'done2' });
      await resetP;
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValueOnce(
        new ToolTimeoutError('verifier', 3000)
      );
      // phase 425: iter 3 retry_count=3=maxAttempts、走 force-accept path 不 retry path、等 SUBTASK_FORCE_ACCEPTED
      const forceAcceptedP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);
      await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: 'done3' });
      await forceAcceptedP;
      spy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('subagent_timeout');
    });
});
