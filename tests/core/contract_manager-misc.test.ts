/**
 * ContractSystem misc tests (phase 1339 split)
 *
 * Extracted from contract_manager-escalation.test.ts:65-301 (LLM verification + force-accept writes force_accepted + phase239 audit lifecycle).
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
import { makeAudit, makeMockAudit, waitForAuditEvent, waitForNextAuditEvent } from '../helpers/audit.js';
import { DEFAULT_MAX_STEPS } from '../../src/core/agent-executor/index.js';  // phase 262: hoist

/**
 * Mutex release microtask grace (50ms): 等 background verification 释放 mutex 后继续.
 * Derivation: phase 1371 sub-3 / > microtask flush 1 turn / 给 saveProgress 落定 audit emit 窗口.
 */
const MUTEX_RELEASE_GRACE_MS = 50;

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
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  describe('LLM verification', () => {
    it('should reset subtask to todo when verifier throws exception', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      // Create contract with LLM verification
      const contractId = await testManager.create(makeContractYaml({
        title: 'Test',
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
      expect(DEFAULT_MAX_STEPS).toBe(1000);
    });
  });

  // === Phase 137: force_accepted written when retry_count reaches maxAttempts ===

  describe('force-accept writes force_accepted', () => {
    it('should set force_accepted after reaching max attempts', async () => {
      const { audit: mockAudit, events, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Force Accept Test',
        goal: 'Test force_accepted',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
        verification_attempts: 2,
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

      // verification_attempts = 2, need 2 failures to trigger force-accept
      for (let i = 0; i < 2; i++) {
        const verifDoneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await verifDoneP;
        // phase 1371 sub-3: extra grace for mutex release microtask to land
        await new Promise(r => setTimeout(r, MUTEX_RELEASE_GRACE_MS));
      }

      // SUBTASK_FORCE_ACCEPTED 在 saveProgress 之后 emit（verification-notify.ts 顺序）、fast-path 等
      await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);

      scriptSpy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(2);
      expect(progress.subtasks['t1'].force_accepted).toBe(true);
    });

    it('should not set force_accepted before reaching max attempts', async () => {
      const { audit: mockAudit, emitter } = makeAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'No Force Accept Test',
        goal: 'Test no force_accepted',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [
          { subtask_id: 't1', type: 'script', script_file: 'verification/t1.sh' },
        ],
        verification_attempts: 3,
      }));

      const contractDir = path.join(clawDir, 'contract/active', contractId);
      await fs.mkdir(path.join(contractDir, 'verification'), { recursive: true });
      await fs.writeFile(path.join(contractDir, 'verification', 't1.sh'), '#!/bin/sh\nexit 1');
      await fs.chmod(path.join(contractDir, 'verification', 't1.sh'), 0o755);

      const scriptSpy = vi.spyOn(testManager as any, 'runScriptVerification').mockResolvedValue({
        passed: false,
        feedback: 'verification failed',
      });

      // Only 2 failures — below verification_attempts (3)
      for (let i = 0; i < 2; i++) {
        const verifDoneP = waitForNextAuditEvent(emitter, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);
        await testManager.completeSubtask({ contractId, subtaskId: 't1', evidence: `attempt ${i + 1}` });
        await verifDoneP;
        // phase 1371 sub-3: extra grace for mutex release microtask to land
        await new Promise(r => setTimeout(r, MUTEX_RELEASE_GRACE_MS));
      }

      scriptSpy.mockRestore();

      const progress = await testManager.getProgress(contractId);
      expect(progress.subtasks['t1'].retry_count).toBe(2);
      expect(progress.subtasks['t1'].force_accepted).toBeUndefined();
    });
  });

  // === Phase 239: B.2 Monitor 废止 sub-phase 1 — audit 生命周期事件断言 ===

  describe('phase239 audit lifecycle events', () => {
    it('writes CONTRACT_CREATED audit on contract creation', async () => {
      const mockAudit = makeMockAudit();
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'AuditLog Lifecycle Test',
        goal: 'Test',
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
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      // Create contract with script verification (triggers async background verification)
      const contractId = await testManager.create(makeContractYaml({
        title: 'Async Acceptance Test',
        goal: 'Test',
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
      const testManager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: mockAudit, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

      const contractId = await testManager.create(makeContractYaml({
        title: 'Contract Updated Test',
        goal: 'Test',
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
