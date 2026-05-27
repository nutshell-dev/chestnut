/**
 * ContractSystem misc tests (phase 1339 split)
 *
 * Extracted from contract_manager-escalation.test.ts:65-301 (LLM verification + escalation writes escalated_at + phase239 audit lifecycle).
 * All 7 tests use vi.spyOn only (no spawn / no concurrent lock) → fast project.
 *
 * This commit also deletes contract_manager-escalation.test.ts (empty after this extraction).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';
import { waitFor } from '../helpers/wait-for.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeMockAudit } from '../helpers/audit.js';

let testDir: string;
let clawDir: string;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContractSystem - misc (LLM verification + escalation + phase239 audit)', () => {
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-contract-misc-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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
});
