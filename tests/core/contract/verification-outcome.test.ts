/**
 * Phase 1201 Step C: durable verification outcome store — schema / exclusive /
 * idempotency / strict reader.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
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
