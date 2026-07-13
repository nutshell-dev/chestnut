/**
 * Phase 961 — verification attempt ID + archive under lock + audit isolation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit, waitForAuditEvent, makeMockAudit } from '../../helpers/audit.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { runVerificationInBackground } from '../../../src/core/contract/verification.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-phase961-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

function makeManager(audit: any) {
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
  });
}

describe('Phase 961 verification invariants', () => {
  it('rejects late result with mismatched verification_attempt_id', async () => {
    const mockAudit = makeMockAudit();
    const moveToArchiveSpy = vi.fn().mockResolvedValue(undefined);
    const emitContractCompletedSpy = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      clawDir: '/tmp/claw',
      clawId: 'claw-test',
      audit: mockAudit as unknown as VerificationContext['audit'],
      notifyClaw: vi.fn(),
      contractDir: vi.fn().mockResolvedValue('contract/active'),
      loadContractYaml: vi.fn().mockResolvedValue({}),
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: {
          t1: { status: 'in_progress', verification_attempt_id: 'attempt-B' },
        },
      }),
      saveProgress: vi.fn().mockResolvedValue(undefined),
      withProgressLock: vi.fn().mockImplementation((_, fn) => fn()),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(true),
      moveContractToArchive: moveToArchiveSpy,
      emitContractCompleted: emitContractCompletedSpy,
      runLLMVerification: vi.fn().mockResolvedValue({ passed: true, feedback: 'ok' }),
      runScriptVerification: vi.fn(),
      toolRegistry: createToolRegistry(),
      verificationMutex: { acquire: vi.fn(() => true), release: vi.fn() } as unknown as VerificationContext['verificationMutex'],
      runVerifierWithCancel: vi.fn(),
      onNotify: vi.fn(),
    } as unknown as VerificationContext;

    const contractYaml = makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 't1', evidence: 'e1', attemptId: 'attempt-A' },
      contractYaml,
      { subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' },
    );

    // Stale attemptId A does not match current attemptId B; outcome is skipped and no archive happens.
    expect(moveToArchiveSpy).not.toHaveBeenCalled();
    expect(emitContractCompletedSpy).not.toHaveBeenCalled();

    const mismatchAudit = vi.mocked(mockAudit.write).mock.calls.find(
      c => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED && c.some(col => String(col).includes('context=attempt_id_mismatch')),
    );
    expect(mismatchAudit).toBeDefined();
  });

  it('does not archive paused contract after verification', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
    }));

    let pauseDone = false;
    vi.spyOn(manager as any, 'runLLMVerification').mockImplementation(async () => {
      // Pause the contract before returning the passing result.
      if (!pauseDone) {
        pauseDone = true;
        await manager.pause(contractId, 'pause before archive');
      }
      return { passed: true, feedback: 'ok' };
    });

    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE);

    const progress = await manager.getProgress(contractId);
    expect(progress?.status).toBe('paused');

    const contractDir = await (manager as any).contractDir(contractId);
    expect(contractDir).toBe('contract/paused');
  });

  it('resets subtask even when audit emit throws', async () => {
    const { audit, events, emitter } = makeAudit();
    const manager = makeManager(audit);

    const contractId = await manager.create(makeContractYaml({
      subtasks: [{ id: 't1', description: 'd1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verify.prompt' }],
    }));

    vi.spyOn(manager as any, 'runLLMVerification').mockRejectedValue(new Error(' verifier crashed'));

    // Make the audit emit throw only for the background-failure audit event.
    const originalWrite = audit.write;
    audit.write = vi.fn((type: string, ...cols: (string | number)[]) => {
      if (type === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_FAILED) {
        throw new Error('audit emit failed');
      }
      return originalWrite(type, ...cols);
    });

    await manager.completeSubtask({ contractId, subtaskId: 't1', evidence: 'e1' });
    await vi.waitFor(async () => {
      const p = await manager.getProgress(contractId);
      expect(p?.subtasks.t1.status).toBe('todo');
    }, { timeout: 10000 });

    const progress = await manager.getProgress(contractId);
    expect(progress?.subtasks.t1.retry_count).toBe(1);
  });
});
