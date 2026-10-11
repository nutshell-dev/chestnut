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
import { completeSubtask } from '../helpers/contract-subtask.js';
// phase 1465: 旧全局 reset hook 早已移除；Phase 1201 Step D 起并发闸门整体删除，
// duplicate submit 由 queued fresh-read status/attempt 规则决定。

/**
 * Retry exponential backoff base delay: set to 0 in tests because the retry
 * count assertions do not depend on real wall-clock backoff delays.
 */
const RETRY_BASE_DELAY_MS = 0;

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Retry completeSubtask on transient concurrent-start race ("Cannot start verification"),
 * with exponential backoff (50/100/200/400/800ms, 5 attempts).
 */
async function completeSubtaskWithRetry(
  manager: ContractSystem,
  params: { contractId: string; subtaskId: string; evidence: string },
  maxRetries = 5,
): Promise<ReturnType<ContractSystem['completeSubtask']>> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await completeSubtask(manager, params);
    } catch (e: any) {
      if (e?.message?.includes('Cannot start verification') && attempt < maxRetries - 1) {
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      const result = await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });
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

    it('programming bug throw → 执行不可用释放 todo、零拒绝预算（Phase 1934 Step E 语义修正）', async () => {
      // F-09：throw 是执行不可用不是业务否决——不再计 programming_bug / 不消耗预算；
      // UNEXPECTED_ASYNC_THROW 审计保留。等待信号从 SUBTASK_RESET_TO_TODO 改为 BACKGROUND_DONE。
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

      const doneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
      await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });
      await doneP;

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBeUndefined();
      expect(progress.subtasks['t1'].last_failed_feedback).toBeUndefined();

      const unexpectedThrowCalls = events.filter(
        (e) => e[0] === CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW
      );
      expect(unexpectedThrowCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(unexpectedThrowCalls[0][4]).toContain('TypeError');
    });

    it('subagent timeout → 执行不可用释放 todo、零拒绝预算（Phase 1934 Step E 语义修正）', async () => {
      // F-09：超时属执行失败，不再以 subagent_timeout 消耗拒绝预算。
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

      const doneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
      await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });
      await doneP;

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBeUndefined();
      expect(progress.subtasks['t1'].last_failed_feedback).toBeUndefined();
    });

    it('onNotify verification_failed payload = VerificationFailedNotification typed event', async () => {
      const { audit: mockAudit, emitter } = makeAudit();
      const onNotifySpy = vi.fn();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
    // phase 1872 Step F: onNotify 构造参数一次固定（setter 退役）
    onNotify: onNotifySpy,});

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
      await completeSubtask(testManager, { contractId, subtaskId: 't1', evidence: 'done' });
      await verifDoneP;

      // phase 1260 Step A: typed event 精确断言（canonical camelCase / legacy snake 归 Assembly mapper）
      const notifyCall = onNotifySpy.mock.calls.find(
        (call: any[]) => call[0].type === 'verification_failed'
      );
      expect(notifyCall).toBeDefined();
      expect(notifyCall![0]).toEqual({
        type: 'verification_failed',
        contractId,
        subtaskId: 't1',
        cause: 'llm_rejected',
        feedback: 'rejected by LLM',
        retryCount: 1,
        maxAttempts: 3,
      });
    });

    it('max_attempts 后 subtask force_accepted（status=completed）', async () => {
      const { audit: mockAudit, events, emitter } = makeAudit();
      const onNotifySpy = vi.fn();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
    // phase 1872 Step F: onNotify 构造参数一次固定（setter 退役）
    onNotify: onNotifySpy,});

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

      // phase 1260 Step A: force-accept subtask_completed typed event 精确断言
      const forceAcceptedEvents = onNotifySpy.mock.calls
        .map((call: any[]) => call[0])
        .filter((e: any) => e?.type === 'subtask_completed' && e.forceAccepted === true);
      expect(forceAcceptedEvents).toEqual([{
        type: 'subtask_completed',
        contractId,
        subtaskId: 't1',
        forceAccepted: true,
      }]);
    });

    it('retry_count 仅真实否决递增；执行异常不增预算、不触发 force_accept（Phase 1934 Step E 语义修正）', async () => {
      // F-09：iter1 真实否决（passed:false）计 1；iter2/3 throw 为执行不可用，不增不计。
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
      let waitP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO);
      await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: 'done1' });
      await waitP;
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValueOnce(
        new Error('bug')
      );
      waitP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
      await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: 'done2' });
      await waitP;
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValueOnce(
        new ToolTimeoutError('verifier', 3000)
      );
      waitP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
      await completeSubtaskWithRetry(testManager, { contractId, subtaskId: 't1', evidence: 'done3' });
      await waitP;
      spy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      // 仅 iter1 真实否决计入；两次执行异常零预算消耗、零 force_accept
      expect(progress.subtasks['t1'].retry_count).toBe(1);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].force_accepted).toBeUndefined();
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('llm_rejected');
    });
});