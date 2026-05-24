/**
 * contract-motion-full-chain e2e (phase 1168 α-5)
 *
 * 验证 contract system 全链：create → completeSubtask → verifier → acceptance → archive。
 * Mirror phase 1020 cancel propagation 装配 + stub runContractVerifier。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { makeContractYaml } from '../helpers/contract-yaml.js';
import { CONTRACT_AUDIT_EVENTS } from '../../src/core/contract/audit-events.js';

const { mockRunContractVerifier } = vi.hoisted(() => ({
  mockRunContractVerifier: vi.fn(),
}));

vi.mock('../../src/core/contract/verifier-job.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/contract/verifier-job.js')>();
  return {
    ...mod,
    runContractVerifier: mockRunContractVerifier,
  };
});

describe('contract-motion-full-chain (phase 1168 α-5)', () => {
  let testDir: string;
  let clawDir: string;
  let manager: ContractSystem;
  let nodeFs: NodeFileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockRunContractVerifier.mockReset();

    testDir = path.join(os.tmpdir(), `.test-contract-motion-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    auditEvents = [];
    const audit = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEvents.push([type, ...cols]);
      },
    };
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem(clawDir, 'test-claw', nodeFs, audit as any, mockLlm, createToolRegistry());
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  async function setupPromptFile(contractId: string) {
    const promptDir = path.join(clawDir, 'contract/active', contractId, 'acceptance');
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(path.join(promptDir, 'task-1.prompt.txt'), 'Check: {{evidence}}');
  }

  async function waitForAudit(type: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (auditEvents.some(e => e[0] === type)) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for audit event ${type}`);
  }

  async function waitForArchive(contractId: string, timeoutMs = 5000): Promise<boolean> {
    const archiveDir = path.join(clawDir, 'contract/archive', contractId);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await fs.access(archiveDir);
        return true;
      } catch {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    return false;
  }

  // ───── Case 1: happy path ─────
  it('happy: completeSubtask → verifier PASS → acceptance archive', async () => {
    mockRunContractVerifier.mockResolvedValue({
      passed: true,
      structured: { passed: true, reason: 'ok' },
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Happy Contract',
      subtasks: [{ id: 'task-1', description: 'T1' }],
      acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
    }));

    await setupPromptFile(contractId);

    await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    await waitForAudit('contract_acceptance_background_done');
    const archived = await waitForArchive(contractId);
    expect(archived).toBe(true);

    const passedEvents = auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.PASSED);
    expect(passedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ───── Case 2: verifier FAIL ─────
  it('verifier FAIL → acceptance reject + acceptance_failed audit', async () => {
    mockRunContractVerifier.mockResolvedValue({
      passed: false,
      feedback: 'rejected by verifier',
      structured: { passed: false, reason: 'bad', issues: ['issue1'] },
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Fail Contract',
      subtasks: [{ id: 'task-1', description: 'T1' }],
      acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
    }));

    await setupPromptFile(contractId);

    await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    await waitForAudit('contract_acceptance_background_done');

    const failedEvents = auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_FAILED);
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    const archiveDir = path.join(clawDir, 'contract/archive', contractId);
    const archived = await fs.access(archiveDir).then(() => true).catch(() => false);
    expect(archived).toBe(false);
  });

  // ───── Case 3: cancel mid-flight ─────
  it('cancel mid-flight → verifier abort + no acceptance_failed to cancelled inbox', async () => {
    let abortHandler: (() => void) | null = null;

    mockRunContractVerifier.mockImplementation(async (config: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        const onAbort = () => reject(new Error('AbortError: signal aborted'));
        if (config.signal?.aborted) {
          onAbort();
          return;
        }
        config.signal?.addEventListener('abort', onAbort);
        abortHandler = () => config.signal?.removeEventListener('abort', onAbort);
      });
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Cancel Contract',
      subtasks: [{ id: 'task-1', description: 'T1' }],
      acceptance: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'acceptance/task-1.prompt.txt' }],
    }));

    await setupPromptFile(contractId);

    const completePromise = manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });
    await completePromise;

    // Wait for verifier to start (active verifier count > 0)
    await vi.waitFor(
      () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
      { timeout: 5000, interval: 10 },
    );

    await manager.cancel(contractId, 'test cancel');

    // Wait for background to finish
    await waitForAudit('contract_acceptance_background_done', 8000);

    // acceptance_failed should NOT be emitted for cancelled contract
    const failedEvents = auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ACCEPTANCE_FAILED);
    expect(failedEvents.length).toBe(0);

    abortHandler?.();
  }, 15000);
});
