/**
 * verification pure-fn cluster unit tests (phase 990 / r121 F fork)
 *
 * Tests formatRejectionFeedback (pure) + runScriptVerification path-safety & exec handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as nodeFs from 'fs';
import * as path from 'path';
import { makeMockAudit } from '../../helpers/audit.js';
import { formatRejectionFeedback, runScriptVerification, runLLMVerification, runVerificationInBackground, runVerificationPipeline } from '../../../src/core/contract/verification.js';
import { VerificationMutex } from '../../../src/core/contract/verification-mutex.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { VerificationContext } from '../../../src/core/contract/verification.js';

const mockExec = vi.fn();

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    exec: mockExec,
    fs: { realpathSync: vi.fn((p: string) => p) } as unknown as FileSystem,
    contractDir: vi.fn().mockResolvedValue('contract/active'),
    withProgressLock: vi.fn((_id, fn) => fn()),
    getProgress: vi.fn().mockResolvedValue(null),
    saveProgress: vi.fn().mockResolvedValue(undefined),
    loadContractYaml: vi.fn().mockResolvedValue(null),
    verificationMutex: new VerificationMutex(),
    toolRegistry: {} as VerificationContext['toolRegistry'],
    runScriptVerification: vi.fn(),
    runLLMVerification: vi.fn(),
    runVerifierWithCancel: vi.fn(),
    isActiveContract: vi.fn().mockResolvedValue(true),
    getContractRoot: vi.fn().mockResolvedValue('contract/active'),
    transitionVerificationAttempt: vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'not configured' }),
    ...overrides,
  } as VerificationContext;
}

describe('formatRejectionFeedback (phase 990)', () => {
  it('formats full rejection with issues', () => {
    const text = formatRejectionFeedback(
      'st-1',
      'desc A',
      'reason X',
      ['issue1', 'issue2'],
      2,
      3,
      'script',
      'check.sh',
    );
    expect(text).toContain('st-1');
    expect(text).toContain('desc A');
    expect(text).toContain('reason X');
    expect(text).toContain('- issue1');
    expect(text).toContain('- issue2');
    expect(text).toContain('2/3 次');
    expect(text).toContain('script (check.sh)');
  });

  it('formats rejection without issues', () => {
    const text = formatRejectionFeedback(
      'st-2',
      'desc B',
      'reason Y',
      [],
      1,
      5,
      'llm',
      'prompt.md',
    );
    expect(text).toContain('(未提供具体问题)');
    expect(text).toContain('llm (prompt.md)');
  });
});

describe('runScriptVerification (phase 990)', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('rejects path escape attempt', async () => {
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, '../escape.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('路径安全拒绝');
  });

  it('returns passed when script exits 0', async () => {
    mockExec.mockResolvedValue(undefined);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(true);
    expect(result.feedback).toContain('passed');
  });

  it('returns failed with first line on ProcessExecError', async () => {
    const err = new ProcessExecError({ message: 'sh failed', output: 'first bad line\nsecond line', exitCode: 1 });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('first bad line');
  });

  it('returns timeout feedback when killed', async () => {
    const err = new ProcessExecError({ message: 'timeout', output: 'took too long', exitCode: null, killed: true });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('超时');
  });

  it('rejects script path that is a symlink outside contract dir', async () => {
    const contractDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'phase963-contract-'));
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const outsideFile = path.join(os.tmpdir(), `phase963-outside-${Date.now()}.sh`);
    nodeFs.writeFileSync(outsideFile, '#!/bin/sh\necho evil');
    const linkPath = path.join(contractDir, 'check.sh');
    nodeFs.symlinkSync(outsideFile, linkPath);
    try {
      const ctx = makeCtx({ fs: new NodeFileSystem({ baseDir: contractDir }) });
      const result = await runScriptVerification(ctx, 'check.sh', contractDir);
      expect(result.passed).toBe(false);
      expect(result.feedback).toContain('安全拒绝');
    } finally {
      nodeFs.rmSync(linkPath);
      nodeFs.rmSync(outsideFile);
      nodeFs.rmdirSync(contractDir);
    }
  });

  it('passes signal to script execution', async () => {
    const signal = new AbortController().signal;
    const mockExecWithSignal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ exec: mockExecWithSignal, signal });
    await runScriptVerification(ctx, 'test.sh', '/tmp/contract');
    expect(mockExecWithSignal).toHaveBeenCalledWith('sh', [expect.any(String)], expect.objectContaining({ signal }));
  });
});

describe('runLLMVerification (phase 963)', () => {
  it('propagates abort from LLM verification instead of returning passed:false', async () => {
    const contractDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'phase963-llm-'));
    nodeFs.writeFileSync(path.join(contractDir, 'prompt.md'), '{{evidence}}');
    const controller = new AbortController();
    controller.abort();
    try {
      const ctx = makeCtx({
        signal: controller.signal,
        fs: new NodeFileSystem({ baseDir: contractDir }),
        clawDir: contractDir,
        llm: {} as VerificationContext['llm'],
        toolRegistry: {} as VerificationContext['toolRegistry'],
        runVerifierWithCancel: vi.fn().mockRejectedValue(new Error('AbortError')),
      });
      await expect(
        runLLMVerification(ctx, 'prompt.md', contractDir, 'c1', 'st1', 'desc', 'evidence', []),
      ).rejects.toThrow('AbortError');
    } finally {
      nodeFs.rmSync(path.join(contractDir, 'prompt.md'));
      nodeFs.rmdirSync(contractDir);
    }
  });
});

describe('runVerificationInBackground (Phase 965)', () => {
  it('does not start verification when controller registration fails (Phase 967)', async () => {
    const registerController = vi.fn().mockImplementation(() => { throw new Error('audit fail'); });
    const runScriptVerification = vi.fn().mockResolvedValue({ passed: true, feedback: '' });
    const ctx = makeCtx({
      registerController,
      runScriptVerification,
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await expect(
      runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
        contractYaml,
        verificationConfig,
      ),
    ).rejects.toThrow('audit fail');

    expect(runScriptVerification).not.toHaveBeenCalled();
  });

  it('re-throws abort instead of writing verification error', async () => {
    const registerController = vi.fn();
    const unregisterController = vi.fn();
    const ctx = makeCtx({
      runScriptVerification: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
      registerController,
      unregisterController,
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await expect(
      runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
        contractYaml,
        verificationConfig,
      ),
    ).rejects.toThrow('aborted');

    expect(registerController).toHaveBeenCalledTimes(1);
    expect(unregisterController).toHaveBeenCalledTimes(1);
  });

  it('writes verification error for non-abort background failures', async () => {
    const registerController = vi.fn();
    const unregisterController = vi.fn();
    const ctx = makeCtx({
      runScriptVerification: vi.fn().mockRejectedValue(new Error('script failed')),
      registerController,
      unregisterController,
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      verificationConfig,
    );

    expect(registerController).toHaveBeenCalledTimes(1);
    expect(unregisterController).toHaveBeenCalledTimes(1);
  });

  it('resets subtask to todo on abort via interrupt transition (Phase 1136 Step D)', async () => {
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'updated',
      progress: {
        status: 'running',
        subtasks: {
          st1: { status: 'todo' },
        },
      },
    });
    const ctx = makeCtx({
      transitionVerificationAttempt,
      runScriptVerification: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await expect(
      runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
        contractYaml,
        verificationConfig,
      ),
    ).rejects.toThrow('aborted');

    expect(transitionVerificationAttempt).toHaveBeenCalledWith(
      'c1',
      'st1',
      expect.objectContaining({ kind: 'interrupt', attemptId: 'a1' }),
    );
  });

  it('lets gateway classify missing verification_attempt_id as skipped (Phase 1143)', async () => {
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'skipped',
      reason: 'attempt id mismatch',
    });
    const progress = {
      status: 'running',
      subtasks: {
        st1: { status: 'in_progress' }, // no verification_attempt_id
      },
    };
    const getProgress = vi.fn().mockResolvedValue(progress);
    const ctx = makeCtx({
      getProgress,
      saveProgress,
      transitionVerificationAttempt,
      runScriptVerification: vi.fn().mockResolvedValue({ passed: true, feedback: '' }),
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      verificationConfig,
    );

    // The stale/missing attempt guard is now in the gateway; orchestrator no longer short-circuits.
    expect(transitionVerificationAttempt).toHaveBeenCalled();
    expect(saveProgress).not.toHaveBeenCalled();
    expect(progress.subtasks.st1.status).toBe('in_progress');
    expect(progress.subtasks.st1.verification_attempt_id).toBeUndefined();
  });

  it('records background done as late and skips side effects on attempt mismatch', async () => {
    const mockAudit = makeMockAudit();
    const transitionVerificationAttempt = vi.fn().mockResolvedValue({
      kind: 'late',
      expectedAttemptId: 'attempt-B',
      actualAttemptId: 'attempt-A',
    });
    const ctx = makeCtx({
      audit: mockAudit as unknown as VerificationContext['audit'],
      transitionVerificationAttempt,
      getProgress: vi.fn().mockResolvedValue({
        status: 'running',
        subtasks: {
          st1: { status: 'in_progress', verification_attempt_id: 'attempt-B' },
        },
      }),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(true),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: true, feedback: '' }),
      moveContractToArchive: vi.fn(),
      emitContractCompleted: vi.fn(),
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'attempt-A' },
      contractYaml,
      verificationConfig,
    );

    const doneCalls = vi.mocked(mockAudit.write).mock.calls.filter(
      c => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0].some(col => String(col).includes('result=late'))).toBe(true);

    expect(vi.mocked(mockAudit.write).mock.calls.some(
      c => c[0] === CONTRACT_AUDIT_EVENTS.PASSED || c[0] === CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
    )).toBe(false);
    expect(vi.mocked(mockAudit.write).mock.calls.some(
      c => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED,
    )).toBe(false);
    expect(ctx.moveContractToArchive).not.toHaveBeenCalled();
    expect(ctx.emitContractCompleted).not.toHaveBeenCalled();
    expect(ctx.notifyClaw).not.toHaveBeenCalled();
  });
});

describe('runVerificationPipeline (Phase 968)', () => {
  it('does not start background verification when contract is not active (lifecycle guard)', async () => {
    const contractId = 'c1';
    const subtaskId = 'st1';
    const progress = {
      status: 'running',
      subtasks: {
        [subtaskId]: { status: 'todo' },
      },
    };
    const audit = makeMockAudit();
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      audit: audit as unknown as VerificationContext['audit'],
      saveProgress,
      getProgress: vi.fn().mockResolvedValue(progress),
      isActiveContract: vi.fn().mockResolvedValue(false),
      loadContractYaml: vi.fn().mockResolvedValue({
        subtasks: [{ id: subtaskId, description: 'desc' }],
        verification: [{ subtask_id: subtaskId, type: 'script', script_file: 'check.sh' }],
      }),
    });

    const result = await runVerificationPipeline(ctx, {
      contractId,
      subtaskId,
      evidence: 'ev',
    });

    expect(result.passed).toBe(false);
    expect(result.async).toBeUndefined();
    expect(result.feedback).toContain('not active');
    expect(saveProgress).not.toHaveBeenCalled();
    expect(progress.subtasks[subtaskId].status).toBe('todo');
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED,
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining(`subtaskId=${subtaskId}`),
      expect.stringContaining('runVerificationPipeline'),
      expect.stringContaining('not active'),
    );

    // mutex 已释放：同 (contractId, subtaskId) 再次 acquire 成功
    expect(ctx.verificationMutex.acquire(contractId, subtaskId)).toBe(true);
  });
});

describe('applyVerificationOutcome transition audit ordering (Phase 1136 Step C)', () => {
  it('commits transition before emitting subtask completion audit', async () => {
    const calls: string[] = [];
    const mockAudit = makeMockAudit();
    const audit: VerificationContext['audit'] = {
      ...mockAudit,
      write: vi.fn((type: string, ..._cols: (string | number)[]) => {
        calls.push(`audit:${type}`);
      }) as unknown as VerificationContext['audit']['write'],
    };
    const progress = {
      status: 'running',
      subtasks: {
        st1: { status: 'in_progress', verification_attempt_id: 'a1' },
      },
    };
    const updatedProgress = {
      status: 'running',
      subtasks: {
        st1: { status: 'completed', completed_at: '2026-07-19T10:05:00Z', verification_attempt_id: 'a1' },
      },
    };
    const transitionVerificationAttempt = vi.fn().mockImplementation(() => {
      calls.push('transition');
      return Promise.resolve({ kind: 'updated', progress: updatedProgress });
    });
    const ctx = makeCtx({
      audit,
      transitionVerificationAttempt,
      getProgress: vi.fn().mockResolvedValue(progress),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
      registerController: vi.fn(),
      unregisterController: vi.fn(),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: true, feedback: '' }),
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      verificationConfig,
    );

    expect(transitionVerificationAttempt).toHaveBeenCalled();
    expect(calls).toContain('transition');
    expect(calls).toContain(`audit:${CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED}`);
    expect(calls).toContain(`audit:${CONTRACT_AUDIT_EVENTS.PASSED}`);
    expect(calls.indexOf('transition')).toBeLessThan(calls.indexOf(`audit:${CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED}`));
    expect(calls.indexOf('transition')).toBeLessThan(calls.indexOf(`audit:${CONTRACT_AUDIT_EVENTS.PASSED}`));
  });
});


describe('applyVerificationOutcome reject transition audit ordering (Phase 1142)', () => {
  function makeAuditWithCalls(calls: string[]) {
    const mockAudit = makeMockAudit();
    return {
      audit: {
        ...mockAudit,
        write: vi.fn((type: string, ..._cols: (string | number)[]) => {
          calls.push(`audit:${type}`);
        }) as unknown as VerificationContext['audit']['write'],
      } as VerificationContext['audit'],
      mockAudit,
    };
  }

  const startProgress = {
    status: 'running',
    subtasks: {
      st1: { status: 'in_progress', verification_attempt_id: 'a1' },
    },
  };

  const retryProgress = {
    status: 'running',
    subtasks: {
      st1: { status: 'todo', retry_count: 1, verification_attempt_id: 'a1' },
    },
  };

  it('emits verification_failed only after reject transition commits', async () => {
    const calls: string[] = [];
    const { audit } = makeAuditWithCalls(calls);

    const transitionVerificationAttempt = vi.fn().mockImplementation((_, __, args) => {
      if (args.kind === 'start') {
        calls.push('transition:start:resolved');
        return Promise.resolve({ kind: 'updated', progress: startProgress });
      }
      calls.push('transition:reject:resolved');
      return Promise.resolve({ kind: 'updated', progress: retryProgress });
    });

    const ctx = makeCtx({
      audit,
      transitionVerificationAttempt,
      getProgress: vi.fn().mockResolvedValue(startProgress),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
      registerController: vi.fn(),
      unregisterController: vi.fn(),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: false, feedback: 'bad' }),
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
      verification_attempts: 3,
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      verificationConfig,
    );

    const verificationFailedEvents = calls.filter(c => c === `audit:${CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED}`);
    expect(verificationFailedEvents).toHaveLength(1);
    expect(calls).toContain(`audit:${CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO}`);
    expect(calls.indexOf('transition:reject:resolved')).toBeLessThan(
      calls.indexOf(`audit:${CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED}`),
    );
    expect(calls.indexOf(`audit:${CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED}`)).toBeLessThan(
      calls.indexOf(`audit:${CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO}`),
    );
  });

  it('does not emit verification_failed when reject transition is skipped', async () => {
    const calls: string[] = [];
    const { audit } = makeAuditWithCalls(calls);

    const transitionVerificationAttempt = vi.fn().mockImplementation((_, __, args) => {
      if (args.kind === 'start') {
        return Promise.resolve({ kind: 'updated', progress: startProgress });
      }
      return Promise.resolve({ kind: 'skipped', reason: 'attempt id mismatch' });
    });

    const ctx = makeCtx({
      audit,
      transitionVerificationAttempt,
      getProgress: vi.fn().mockResolvedValue(startProgress),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
      registerController: vi.fn(),
      unregisterController: vi.fn(),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: false, feedback: 'bad' }),
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      verificationConfig,
    );

    const verificationFailedEvents = calls.filter(c => c === `audit:${CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED}`);
    expect(verificationFailedEvents).toHaveLength(0);
  });

  it('does not emit verification_failed when reject transition throws', async () => {
    const calls: string[] = [];
    const { audit } = makeAuditWithCalls(calls);

    let rejectCalls = 0;
    const transitionVerificationAttempt = vi.fn().mockImplementation((_, __, args) => {
      if (args.kind === 'start') {
        return Promise.resolve({ kind: 'updated', progress: startProgress });
      }
      rejectCalls++;
      if (rejectCalls === 1) {
        throw Object.assign(new Error('write failed: ENOSPC'), { code: 'ENOSPC' });
      }
      return Promise.resolve({ kind: 'updated', progress: retryProgress });
    });

    const notifyClaw = vi.fn();
    const ctx = makeCtx({
      audit,
      transitionVerificationAttempt,
      getProgress: vi.fn().mockResolvedValue(startProgress),
      loadContractYaml: vi.fn().mockResolvedValue({
        subtasks: [{ id: 'st1', description: 'desc' }],
        verification_attempts: 3,
      }),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
      registerController: vi.fn(),
      unregisterController: vi.fn(),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: false, feedback: 'bad' }),
      notifyClaw,
    });
    const contractYaml = {
      subtasks: [{ id: 'st1', description: 'desc' }],
      verification_attempts: 3,
    } as any;
    const verificationConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

    // Public promise resolves because runVerificationInBackground catches non-abort errors
    // and routes them through writeVerificationError; the original error is preserved in the inbox.
    await expect(
      runVerificationInBackground(
        ctx,
        { contractId: 'c1', subtaskId: 'st1', evidence: 'ev', attemptId: 'a1' },
        contractYaml,
        verificationConfig,
      ),
    ).resolves.toBeUndefined();

    const verificationFailedEvents = calls.filter(c => c === `audit:${CONTRACT_AUDIT_EVENTS.VERIFICATION_FAILED}`);
    expect(verificationFailedEvents).toHaveLength(0);
    expect(transitionVerificationAttempt).toHaveBeenCalledWith(
      'c1',
      'st1',
      expect.objectContaining({ kind: 'reject' }),
    );
    expect(notifyClaw).toHaveBeenCalledWith(
      ctx.clawId,
      expect.objectContaining({
        type: 'verification_error',
        body: expect.stringContaining('ENOSPC'),
      }),
    );
  });
});
