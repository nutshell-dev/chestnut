/**
 * contract-motion-full-chain e2e (phase 1168 α-5)
 *
 * 验证 contract system 全链：create → completeSubtask → verifier → verification → archive。
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
import {
  WAIT_FOR_DEFAULT_BUDGET_MS,
  SUBAGENT_LONG_TIMEOUT_MS,
} from '../helpers/test-timeouts.js';
import { createAuditEmitterHelper, type AuditEmitterHelper } from '../helpers/audit-emitter.js';
import { waitForPathExists } from '../helpers/wait-for-file.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

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
  let auditHelper: AuditEmitterHelper;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockRunContractVerifier.mockReset();

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(os.tmpdir(), `.test-contract-motion-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });

    nodeFs = new NodeFileSystem({ baseDir: clawDir });
    // phase 361: event-driven audit emitter 替原 setTimeout poll loop
    const baseAudit = {
      write: () => {},
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    auditHelper = createAuditEmitterHelper(baseAudit as never);
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: auditHelper.audit as any, llm: mockLlm, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  async function setupPromptFile(contractId: string) {
    const promptDir = path.join(clawDir, 'contract/active', contractId, 'verification');
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(path.join(promptDir, 'task-1.prompt.txt'), 'Check: {{evidence}}');
  }

  async function waitForAudit(type: string, timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS): Promise<void> {
    // phase 361: event-driven 替原 setTimeout poll
    await auditHelper.waitFor((evs) => evs.some(e => e[0] === type), timeoutMs);
  }

  async function waitForArchive(contractId: string, timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS): Promise<boolean> {
    const archiveDir = path.join(clawDir, 'contract/archive', contractId);
    // phase 367: file-watcher 监父 dir 'addDir' 事件 替原 50ms fs.access polling
    try {
      await waitForPathExists(archiveDir, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  // ───── Case 1: happy path ─────
  it('happy: completeSubtask → verifier PASS → verification archive', async () => {
    mockRunContractVerifier.mockResolvedValue({
      passed: true,
      structured: { passed: true, reason: 'ok' },
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Happy Contract',
      subtasks: [{ id: 'task-1', description: 'T1' }],
      verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
    }));

    await setupPromptFile(contractId);

    await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    await waitForAudit('contract_verification_background_done');
    const archived = await waitForArchive(contractId);
    expect(archived).toBe(true);

    const passedEvents = auditHelper.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.PASSED);
    expect(passedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ───── Case 2: verifier FAIL ─────
  it('verifier FAIL → verification reject + verification_failed audit', async () => {
    mockRunContractVerifier.mockResolvedValue({
      passed: false,
      feedback: 'rejected by verifier',
      structured: { passed: false, reason: 'bad', issues: ['issue1'] },
    });

    const contractId = await manager.create(makeContractYaml({
      title: 'Fail Contract',
      subtasks: [{ id: 'task-1', description: 'T1' }],
      verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
    }));

    await setupPromptFile(contractId);

    await manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });

    await waitForAudit('contract_verification_background_done');

    const failedEvents = auditHelper.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED);
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    const archiveDir = path.join(clawDir, 'contract/archive', contractId);
    const archived = await fs.access(archiveDir).then(() => true).catch(() => false);
    expect(archived).toBe(false);
  });

  // ───── Case 3: cancel mid-flight ─────
  it('cancel mid-flight → verifier abort + no verification_failed to cancelled inbox', async () => {
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
      verification: [{ subtask_id: 'task-1', type: 'llm', prompt_file: 'verification/task-1.prompt.txt' }],
    }));

    await setupPromptFile(contractId);

    const completePromise = manager.completeSubtask({
      contractId,
      subtaskId: 'task-1',
      evidence: 'done',
    });
    await completePromise;

    // phase 376: VERIFIER_REGISTERED audit event 替原 getActiveVerifierCount polling
    await waitForAudit(CONTRACT_AUDIT_EVENTS.VERIFIER_REGISTERED);

    await manager.cancel(contractId, 'test cancel');

    // Wait for background to finish (long-poll budget for verifier teardown).
    await waitForAudit('contract_verification_background_done', SUBAGENT_LONG_TIMEOUT_MS);

    // verification_failed should NOT be emitted for cancelled contract
    const failedEvents = auditHelper.events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED);
    expect(failedEvents.length).toBe(0);

    abortHandler?.();
  }, 15000);
});
