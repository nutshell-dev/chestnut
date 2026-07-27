/**
 * Phase 1201 Step C: durable verification outcome store — schema / exclusive /
 * idempotency / strict reader.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import {
  buildVerificationOutcome,
  isOutcomeAlreadyApplied,
  persistVerificationOutcome,
  readVerificationOutcomesForContract,
  verificationOutcomePath,
  VERIFICATION_OUTCOME_SCHEMA_VERSION,
} from '../../../src/core/contract/verification-outcome.js';
import { makeContractId, makeSubtaskId } from '../../../src/core/contract/types.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanupTempDir(cleanups.pop()!);
});

async function setup() {
  const tempDir = await createTempDir('phase1201-outcome-');
  cleanups.push(tempDir);
  const clawDir = path.join(tempDir, 'claws', 'claw-1');
  await fsp.mkdir(clawDir, { recursive: true });
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const { audit, events } = makeAudit();
  return { tempDir, clawDir, fs, audit, events };
}

const IDENTITY = {
  contractId: makeContractId('c1'),
  subtaskId: makeSubtaskId('st1'),
  attemptId: 'att-1',
  completedAt: '2026-07-27T00:00:00.000Z',
};

function passedOutcome() {
  return buildVerificationOutcome(IDENTITY, {
    kind: 'passed',
    result: { passed: true, feedback: 'ok' },
  });
}

describe('verification outcome store (phase 1201 step C)', () => {
  it('builder produces schema-valid immutable identity + kind payload', () => {
    const outcome = passedOutcome();
    expect(outcome).toEqual({
      schema_version: VERIFICATION_OUTCOME_SCHEMA_VERSION,
      contract_id: 'c1',
      subtask_id: 'st1',
      attempt_id: 'att-1',
      completed_at: '2026-07-27T00:00:00.000Z',
      kind: 'passed',
      result: { passed: true, feedback: 'ok' },
    });
  });

  it('persist new outcome → persisted + exclusive file + audit', async () => {
    const { clawDir, fs, audit, events } = await setup();
    const outcome = passedOutcome();
    const result = await persistVerificationOutcome(fs, audit, clawDir, outcome);
    expect(result).toBe('persisted');

    const onDisk = JSON.parse(await fsp.readFile(
      path.join(clawDir, 'contract', 'verification-outcomes', 'c1', 'att-1.json'),
      'utf-8',
    ));
    expect(onDisk).toEqual(outcome);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_PERSISTED)).toBe(true);
  });

  it('re-persist identical payload → idempotent（不覆盖、audit idempotent）', async () => {
    const { clawDir, fs, audit, events } = await setup();
    const outcome = passedOutcome();
    await persistVerificationOutcome(fs, audit, clawDir, outcome);
    const filePath = path.join(clawDir, 'contract', 'verification-outcomes', 'c1', 'att-1.json');

    const second = await persistVerificationOutcome(fs, audit, clawDir, outcome);
    expect(second).toBe('idempotent');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_IDEMPOTENT)).toBe(true);
    const after = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    expect(after).toEqual(outcome);
  });

  it('EEXIST payload 不同 → conflict fail-closed：原文件保留、audit conflict', async () => {
    const { clawDir, fs, audit, events } = await setup();
    await persistVerificationOutcome(fs, audit, clawDir, passedOutcome());

    const conflicting = buildVerificationOutcome(IDENTITY, {
      kind: 'rejected',
      result: { passed: false, feedback: 'bad' },
      cause: 'llm_rejected',
      maxAttempts: 3,
    });
    const result = await persistVerificationOutcome(fs, audit, clawDir, conflicting);
    expect(result).toBe('conflict');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_CONFLICT)).toBe(true);

    // 原文件未被覆盖、未删除。
    const onDisk = JSON.parse(await fsp.readFile(
      path.join(clawDir, 'contract', 'verification-outcomes', 'c1', 'att-1.json'),
      'utf-8',
    ));
    expect(onDisk.kind).toBe('passed');
  });

  it('strict reader：valid roundtrip + malformed/mismatch fail-closed 保留并 audit issue', async () => {
    const { clawDir, fs, audit, events } = await setup();
    await persistVerificationOutcome(fs, audit, clawDir, passedOutcome());

    // malformed JSON
    const dir = path.join(clawDir, 'contract', 'verification-outcomes', 'c1');
    await fsp.writeFile(path.join(dir, 'att-bad.json'), '{not json', 'utf-8');
    // schema invalid
    await fsp.writeFile(path.join(dir, 'att-schema.json'), JSON.stringify({ kind: 'passed' }), 'utf-8');
    // identity mismatch：filename att-x，内容 attempt_id=att-y
    const mismatch = buildVerificationOutcome(
      { ...IDENTITY, attemptId: 'att-y' },
      { kind: 'passed', result: { passed: true, feedback: 'ok' } },
    );
    await fsp.writeFile(path.join(dir, 'att-x.json'), JSON.stringify(mismatch, null, 2), 'utf-8');

    const { outcomes, issues } = await readVerificationOutcomesForContract(fs, audit, clawDir, makeContractId('c1'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual(passedOutcome());
    const sortedIssues = [...issues].sort((a, b) => a.attemptId.localeCompare(b.attemptId));
    expect(sortedIssues.map(i => [i.attemptId, i.reason])).toEqual([
      ['att-bad', 'parse_failed'],
      ['att-schema', 'schema_invalid'],
      ['att-x', 'identity_mismatch'],
    ]);

    const issueAudits = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_READ_ISSUE);
    expect(issueAudits).toHaveLength(3);

    // 原文件全部保留（fail-closed，不删除）。
    for (const name of ['att-bad.json', 'att-schema.json', 'att-x.json']) {
      await fsp.access(path.join(dir, name));
    }
  });

  it('outcome path 稳定：contract/verification-outcomes/<contract-id>/<attempt-id>.json', () => {
    expect(verificationOutcomePath('/base', makeContractId('c9'), 'a9')).toBe(
      '/base/contract/verification-outcomes/c9/a9.json',
    );
  });
});

describe('isOutcomeAlreadyApplied classification (phase 1201 step C)', () => {
  it('passed：completed + 同 completed_at → already_applied；否则 superseded', () => {
    const outcome = passedOutcome();
    expect(isOutcomeAlreadyApplied(
      { status: 'completed', completed_at: '2026-07-27T00:00:00.000Z' },
      outcome,
    )).toBe(true);
    expect(isOutcomeAlreadyApplied(
      { status: 'completed', completed_at: '2026-07-27T01:00:00.000Z' },
      outcome,
    )).toBe(false);
    expect(isOutcomeAlreadyApplied({ status: 'todo' }, outcome)).toBe(false);
  });

  it('rejected/errored：feedback + retry_count 匹配 → already_applied', () => {
    const rejected = buildVerificationOutcome(IDENTITY, {
      kind: 'rejected',
      result: { passed: false, feedback: 'bad' },
      cause: 'llm_rejected',
      maxAttempts: 3,
    });
    expect(isOutcomeAlreadyApplied(
      { status: 'todo', retry_count: 1, last_failed_feedback: { feedback: 'bad', cause: 'llm_rejected' } },
      rejected,
    )).toBe(true);
    expect(isOutcomeAlreadyApplied(
      { status: 'todo', retry_count: 0 },
      rejected,
    )).toBe(false);

    const errored = buildVerificationOutcome(IDENTITY, {
      kind: 'errored',
      error: { message: 'boom' },
      cause: 'programming_bug',
      feedback: 'crash feedback',
      maxAttempts: 3,
    });
    expect(isOutcomeAlreadyApplied(
      { status: 'todo', retry_count: 1, last_failed_feedback: { feedback: 'crash feedback', cause: 'programming_bug' } },
      errored,
    )).toBe(true);
  });

  it('interrupted：todo + 无 attempt id → already_applied', () => {
    const interrupted = buildVerificationOutcome(IDENTITY, { kind: 'interrupted', reason: 'aborted' });
    expect(isOutcomeAlreadyApplied({ status: 'todo' }, interrupted)).toBe(true);
    expect(isOutcomeAlreadyApplied(
      { status: 'todo', verification_attempt_id: 'att-2' },
      interrupted,
    )).toBe(false);
  });
});

/**
 * Phase 1201 Step E: durable outcome conflict fail-closed 行为验收。
 *
 * pass / reject / errored / interrupted 四类 caller 遇 conflict 均不得
 * transition / archive / retry side effect；idempotent 仍可 guarded apply；
 * background promise 必须 settle（无 unhandled rejection）。
 */
describe('verification outcome conflict fail-closed (phase 1201 step E)', () => {
  const contractYaml = {
    subtasks: [{ id: 'st1', description: 'desc' }],
    verification_attempts: 3,
  } as any;
  const scriptConfig = { subtask_id: 'st1', type: 'script' as const, script_file: 'check.sh' };

  function makeBgCtx(overrides: Record<string, unknown>) {
    return {
      clawDir: '/tmp/claw',
      clawId: 'claw-test',
      audit: makeMockAudit(),
      notifyClaw: vi.fn(),
      fs: {},
      contractDir: vi.fn().mockResolvedValue('contract/active'),
      getContractRoot: vi.fn().mockResolvedValue('contract/active'),
      loadContractYaml: vi.fn().mockResolvedValue(contractYaml),
      getProgress: vi.fn().mockResolvedValue({
        schema_version: 1,
        status: 'running',
        subtasks: { st1: { status: 'in_progress', verification_attempt_id: 'a1' } },
        started_at: '2026-07-27T00:00:00.000Z',
      }),
      isActiveContract: vi.fn().mockResolvedValue(true),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
      transitionVerificationAttempt: vi.fn().mockResolvedValue({ kind: 'updated', progress: { subtasks: {} } }),
      submitSyncCompletion: vi.fn(),
      persistVerificationOutcome: vi.fn().mockResolvedValue('conflict'),
      runScriptVerification: vi.fn(),
      runLLMVerification: vi.fn(),
      runVerifierWithCancel: vi.fn(),
      registerController: vi.fn(),
      unregisterController: vi.fn(),
      onNotify: vi.fn(),
      toolRegistry: {},
      ...overrides,
    } as unknown as import('../../../src/core/contract/verification.js').VerificationContext;
  }

  it('pass outcome conflict → 0 transition、background settle、BACKGROUND_DONE result=error', async () => {
    const { runVerificationInBackground } = await import('../../../src/core/contract/verification.js');
    const ctx = makeBgCtx({
      runScriptVerification: vi.fn().mockResolvedValue({ passed: true, feedback: 'ok' }),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1' as any, subtaskId: 'st1' as any, evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      scriptConfig,
    );

    expect(ctx.persistVerificationOutcome).toHaveBeenCalledTimes(1);
    expect(ctx.transitionVerificationAttempt).not.toHaveBeenCalled();
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE
      && c.some(col => String(col).includes('result=error')))).toBe(true);
  });

  it('reject outcome conflict → 0 transition、0 retry side effect', async () => {
    const { runVerificationInBackground } = await import('../../../src/core/contract/verification.js');
    const ctx = makeBgCtx({
      runScriptVerification: vi.fn().mockResolvedValue({ passed: false, feedback: 'bad' }),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1' as any, subtaskId: 'st1' as any, evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      scriptConfig,
    );

    expect(ctx.persistVerificationOutcome).toHaveBeenCalledTimes(1);
    expect(ctx.transitionVerificationAttempt).not.toHaveBeenCalled();
  });

  it('errored outcome conflict → 0 transition（不形成 conflict 循环）', async () => {
    const { runVerificationInBackground } = await import('../../../src/core/contract/verification.js');
    const ctx = makeBgCtx({
      runScriptVerification: vi.fn().mockRejectedValue(new Error('script crashed')),
    });

    // background 必须 settle（不 throw、无 unhandled rejection）。
    await runVerificationInBackground(
      ctx,
      { contractId: 'c1' as any, subtaskId: 'st1' as any, evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      scriptConfig,
    );

    // errored persist 恰好一次（conflict 后不再被 catch 当成新 errored outcome 重试）。
    expect(ctx.persistVerificationOutcome).toHaveBeenCalledTimes(1);
    expect(ctx.transitionVerificationAttempt).not.toHaveBeenCalled();
  });

  it('interrupted outcome conflict → 0 interrupt transition，abort 仍 rethrow', async () => {
    const { runVerificationInBackground } = await import('../../../src/core/contract/verification.js');
    const ctx = makeBgCtx({
      runScriptVerification: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    });

    await expect(runVerificationInBackground(
      ctx,
      { contractId: 'c1' as any, subtaskId: 'st1' as any, evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      scriptConfig,
    )).rejects.toThrow('aborted');

    expect(ctx.persistVerificationOutcome).toHaveBeenCalledTimes(1);
    expect(ctx.transitionVerificationAttempt).not.toHaveBeenCalled();
  });

  it('idempotent 同 payload → 仍 guarded apply（transition 恰好一次）', async () => {
    const { runVerificationInBackground } = await import('../../../src/core/contract/verification.js');
    const ctx = makeBgCtx({
      persistVerificationOutcome: vi.fn().mockResolvedValue('idempotent'),
      runScriptVerification: vi.fn().mockResolvedValue({ passed: true, feedback: 'ok' }),
    });

    await runVerificationInBackground(
      ctx,
      { contractId: 'c1' as any, subtaskId: 'st1' as any, evidence: 'ev', attemptId: 'a1' },
      contractYaml,
      scriptConfig,
    );

    expect(ctx.persistVerificationOutcome).toHaveBeenCalledTimes(1);
    expect(ctx.transitionVerificationAttempt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.transitionVerificationAttempt).mock.calls[0][2]).toMatchObject({ kind: 'pass', attemptId: 'a1' });
  });
});
