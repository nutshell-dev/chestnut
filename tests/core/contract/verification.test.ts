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

  it('resets subtask to todo on abort (Phase 966)', async () => {
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const getProgress = vi.fn().mockResolvedValue({
      status: 'running',
      subtasks: {
        st1: { status: 'in_progress', verification_attempt_id: 'a1' },
      },
    });
    const ctx = makeCtx({
      getProgress,
      saveProgress,
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

    expect(saveProgress).toHaveBeenCalledTimes(1);
    const savedProgress = saveProgress.mock.calls[0][1];
    expect(savedProgress.subtasks.st1.status).toBe('todo');
    expect(savedProgress.subtasks.st1.verification_attempt_id).toBeUndefined();
  });

  it('rejects late result when verification_attempt_id is missing (Phase 966 ABA guard)', async () => {
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

    // Skipped outcome must not mutate subtask to completed or call saveProgress.
    expect(saveProgress).not.toHaveBeenCalled();
    expect(transitionVerificationAttempt).not.toHaveBeenCalled();
    expect(progress.subtasks.st1.status).toBe('in_progress');
    expect(progress.subtasks.st1.verification_attempt_id).toBeUndefined();
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
