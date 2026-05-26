/**
 * ContractSystem 测试 - 状态转换 (phase 1326 split: LLM/escalation/Contract-shape/phase239-audit/fire-and-forget describes)
 * 
 * 构造函数: new ContractSystem({ clawDir, clawId, fs, audit, llm?, toolRegistry, toolTimeoutMs?, fsFactory })
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
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { waitFor } from '../helpers/wait-for.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { DEAD_PID } from '../helpers/dead-pid.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual };
});

vi.mock('../../src/core/contract/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/contract/constants.js')>();
  return {
    ...actual,
    LOCK_MAX_RETRIES: 3,        // 从 20 降到 3
    LOCK_RETRY_DELAY_MS: 10,    // 从 500ms 降到 10ms
  };
});

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-manager-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');

    vi.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const mockAudit = makeMockAudit();
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });
  });
  describe('LLM verification', () => {
    it('should reset subtask to todo when verifier throws exception', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      // Create contract with LLM verification
      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
        ],
      }));

      // Create prompt file (use native fs with absolute path)
      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(
        path.join(contractDir, 'verification', 't1.prompt.txt'),
        'Check: {{evidence}}, {{artifacts}}'
      );

      // Mock runLLMVerification to throw MaxStepsExceeded
      const runLLMSpy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValue(
        new Error('MaxStepsExceeded: step limit 50 exceeded')
      );

      // Complete subtask (triggers background LLM verification)
      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      // Should indicate async processing
      expect(result.async).toBe(true);

      // Wait for background processing to complete
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      runLLMSpy.mockRestore();

      // Verify subtask was reset to todo (not stuck in in_progress)
      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBe(1);
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('MaxStepsExceeded');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('programming_bug');
    });

    it('should use DEFAULT_MAX_STEPS=1000 for verifier', async () => {
      // Verify the verifier uses the default max steps (unified with other subagents)
      const { DEFAULT_MAX_STEPS } = await import('../../src/core/agent-executor/index.js');
      expect(DEFAULT_MAX_STEPS).toBe(1000);
    });
  });

  // === Phase 137: escalated_at written when retry_count reaches maxRetries ===

  describe('escalation writes escalated_at', () => {
    it('should set escalated_at after reaching max retries', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Escalation Test',
        goal: 'Test escalated_at',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
      }));

      // Create script file so verification config resolves
      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'verification', 't1.sh'), 0o755);

      // Mock runScriptVerification to always reject
      const scriptSpy = vi.spyOn(testManager as any, 'runScriptVerification').mockResolvedValue({
        passed: false,
        feedback: 'verification failed',
        structured: { passed: false, reason: 'test', issues: [] },
      });

      // Default maxRetries = 3, need 3 failures to trigger escalation
      for (let i = 0; i < 3; i++) {
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        // Wait for background verification to complete (subtask leaves in_progress)
        await waitFor(
          async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
          5000,
          10,
        );
      }

      // phase 1305: poll for BOTH escalated_at AND ESCALATED audit emit
      // (race fix: escalated_at saveProgress 可能在 audit emit 前 land /
      //  N=2 累 flaky 实证 phase 1290 R5 + main 复测 2026-05-26)
      await waitFor(
        async () => {
          const escalated = Boolean((await testManager.getProgress(contractId)).subtasks['t1'].escalated_at);
          const escalationEmitted = mockAudit.write.mock.calls.some(
            (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ESCALATED,
          );
          return escalated && escalationEmitted;
        },
        5000,
        10,
      );

      scriptSpy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].escalated_at).toBeDefined();
      expect(new Date(progress.subtasks['t1'].escalated_at!).getTime()).toBeGreaterThan(0);
    });

    it('should not set escalated_at before reaching max retries', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'No Escalation Test',
        goal: 'Test no escalated_at',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'verification', 't1.sh'), 0o755);

      const scriptSpy = vi.spyOn(testManager as any, 'runScriptVerification').mockResolvedValue({
        passed: false,
        feedback: 'verification failed',
      });

      // Only 2 failures — below maxRetries (3)
      for (let i = 0; i < 2; i++) {
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await waitFor(
          async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
          5000,
          10,
        );
      }

      scriptSpy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(2);
      expect(progress.subtasks['t1'].escalated_at).toBeUndefined();
    });
  });

  // === Phase 97 Step 44: Contract / SubTask 删字段验证 ===

  describe('Contract shape after field removal (Step 44)', () => {
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

      // 已删字段不存在于返回对象
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

  // === Phase 239: B.2 Monitor 废止 sub-phase 1 — audit 生命周期事件断言 ===

  describe('phase239 audit lifecycle events', () => {
    it('writes CONTRACT_CREATED audit on contract creation', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'AuditLog Lifecycle Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.CREATED,
        contractId,
        expect.stringContaining('subtasks=1'),
        expect.stringContaining('title=AuditLog Lifecycle Test'),
      );
    });

    it('writes CONTRACT_VERIFICATION_STARTED audit when async verification begins', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      // Create contract with script verification (triggers async background verification)
      const contractId = await testManager.create(makeContractYaml({
        title: 'Async Acceptance Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
      }));

      // Create the script file so verification config resolves
      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.sh'), '#!/bin/sh\nexit 0', { mode: 0o755 });

      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      expect(result.async).toBe(true);

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.VERIFICATION_STARTED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
      );
    });

    it('writes CONTRACT_UPDATED audit on subtask completion', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Contract Updated Test',
        goal: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      }));

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      expect(mockAudit.write).toHaveBeenCalledWith(
        CONTRACT_AUDIT_EVENTS.UPDATED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
        expect.stringContaining('status=completed'),
      );
    });
  });

  describe('fire-and-forget 失败状态机（phase 468 / feedback driven）', () => {
    it('LLM judged failed → cause=llm_rejected + reset todo + retry_count++', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
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

      const result = await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });
      expect(result.async).toBe(true);

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].retry_count).toBe(1);
      expect(progress.subtasks['t1'].last_failed_feedback).toEqual({
        feedback: 'LLM says no',
        cause: 'llm_rejected',
      });
    });

    it('programming bug throw → cause=programming_bug + reset todo', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
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

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('programming_bug');
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('system bug');

      const unexpectedThrowCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW
      );
      expect(unexpectedThrowCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(unexpectedThrowCalls[0][4]).toContain('TypeError');
    });

    it('subagent timeout → cause=subagent_timeout + reset todo', async () => {
      const { ToolTimeoutError } = await import('../../src/foundation/errors.js');
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
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

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].status).toBe('todo');
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('subagent_timeout');
      expect(progress.subtasks['t1'].last_failed_feedback?.feedback).toContain('5000');
    });

    it('onNotify verification_failed payload schema = AcceptanceFailedNotification', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });
      const onNotifySpy = vi.fn();
      testManager.setOnNotify(onNotifySpy);

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
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

      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done' });

      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );

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
        max_retries: 3,
      });
    });

    it('max_retries 后 subtask 仍 todo（不进 failed）', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
        escalation: { max_retries: 2 },
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'verification', 't1.sh'), 0o755);

      vi.spyOn(testManager as any, 'runScriptVerification').mockResolvedValue({
        passed: false,
        feedback: 'verification failed',
      });

      for (let i = 0; i < 3; i++) {
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await waitFor(
          async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
          5000,
          10,
        );
      }

      // Escalation saveProgress runs after inbox write; poll for escalated_at
      await waitFor(
        async () => Boolean((await testManager.getProgress(contractId)).subtasks['t1'].escalated_at),
        5000,
        10,
      );

      const progress = await testManager.getProgress(contractId);
      // phase 1102 con-4: status becomes 'escalated' (not 'failed') after max retries
      expect(progress.subtasks['t1'].status).toBe('escalated');
      expect(progress.subtasks['t1'].status).not.toBe('failed');
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].escalated_at).toBeDefined();

      const escalationCalls = mockAudit.write.mock.calls.filter(
        (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.ESCALATED
      );
      expect(escalationCalls.length).toBeGreaterThan(0); // at least 1; exact count is retry-dependent
      expect(escalationCalls[0]).toEqual(expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.ESCALATED,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('subtaskId=t1'),
      ]));
    });

    it('retry_count 跨多次失败递增', async () => {
      const { ToolTimeoutError } = await import('../../src/foundation/errors.js');
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory });

      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
        deliverables: [],
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
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done1' });
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValueOnce(
        new Error('bug')
      );
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done2' });
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );
      spy.mockRestore();

      spy = vi.spyOn(testManager as any, 'runLLMVerification').mockRejectedValueOnce(
        new ToolTimeoutError('verifier', 3000)
      );
      await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'done3' });
      await waitFor(
        async () => (await testManager.getProgress(contractId)).subtasks['t1'].status !== 'in_progress',
        5000,
        10,
      );
      spy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(3);
      expect(progress.subtasks['t1'].last_failed_feedback?.cause).toBe('subagent_timeout');
    });
  });
});
