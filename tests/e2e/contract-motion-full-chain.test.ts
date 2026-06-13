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
  WAIT_FOR_DEFAULT_POLL_MS,
  SUBAGENT_LONG_TIMEOUT_MS,
} from '../helpers/test-timeouts.js';

/**
 * 紧凑轮询间隔 (5ms) for waitForAudit poll loop.
 * Derivation: phase 224 收紧；> eventloop tick / 给 audit ring flush 最小窗口.
 */
const TIGHT_POLL_MS = 5;

/**
 * 较宽轮询间隔 (50ms) for waitForArchive (fs.access 检测).
 * Derivation: > fs.access syscall budget / < waitForArchive budget 分钟级 / 不刷爆 syscall.
 */
const WIDE_POLL_MS = 50;

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
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    const mockLlm = { id: 'mock-llm' } as any;
    manager = new ContractSystem({ clawDir, clawId: 'test-claw', fs: nodeFs, audit: audit as any, llm: mockLlm, toolRegistry: createToolRegistry(), fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  async function setupPromptFile(contractId: string) {
    const promptDir = path.join(clawDir, 'contract/active', contractId, 'verification');
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(path.join(promptDir, 'task-1.prompt.txt'), 'Check: {{evidence}}');
  }

  async function waitForAudit(type: string, timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (auditEvents.some(e => e[0] === type)) return;
      await new Promise(r => setTimeout(r, TIGHT_POLL_MS));  // phase 224: tighter poll for waitForAudit
    }
    throw new Error(`timeout waiting for audit event ${type}`);
  }

  async function waitForArchive(contractId: string, timeoutMs = WAIT_FOR_DEFAULT_BUDGET_MS): Promise<boolean> {
    const archiveDir = path.join(clawDir, 'contract/archive', contractId);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await fs.access(archiveDir);
        return true;
      } catch {
        await new Promise(r => setTimeout(r, WIDE_POLL_MS));
      }
    }
    return false;
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

    const passedEvents = auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.PASSED);
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

    const failedEvents = auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED);
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

    // Wait for verifier to start (active verifier count > 0)
    await vi.waitFor(
      () => expect(manager.getActiveVerifierCount()).toBeGreaterThanOrEqual(1),
      { timeout: WAIT_FOR_DEFAULT_BUDGET_MS, interval: WAIT_FOR_DEFAULT_POLL_MS },
    );

    await manager.cancel(contractId, 'test cancel');

    // Wait for background to finish (long-poll budget for verifier teardown).
    await waitForAudit('contract_verification_background_done', SUBAGENT_LONG_TIMEOUT_MS);

    // verification_failed should NOT be emitted for cancelled contract
    const failedEvents = auditEvents.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED);
    expect(failedEvents.length).toBe(0);

    abortHandler?.();
  }, 15000);
});
