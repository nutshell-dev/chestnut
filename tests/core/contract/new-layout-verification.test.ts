/**
 * Phase 1136: verification attempt transition state machine and gateway tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import {
  applyVerificationAttemptTransition,
  transitionCurrentVerificationAttempt,
} from '../../../src/core/contract/new-layout.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord } from '../../../src/core/contract/types.js';
import type { VerificationAttemptTransition } from '../../../src/core/contract/verification-transition-types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-new-layout-verification-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
});

function makeContract(subtasks: Array<{ id: string; description: string }> = [{ id: 't1', description: 'D1' }]): PersistedContractYaml {
  return {
    schema_version: 1,
    id: 'cid-1',
    title: 'Test Contract',
    goal: 'Test goal',
    subtasks,
  };
}

function makeTodoRecord(subtaskId: string): SubtaskRuntimeRecord {
  return {
    schema_version: 1,
    subtask_id: subtaskId,
    status: 'todo',
    attempts: [],
  };
}

async function writeCurrentLayout(
  contract: PersistedContractYaml,
  records: Record<string, SubtaskRuntimeRecord>,
) {
  const root = path.join(clawDir, 'contract', 'active', 'current');
  const subtasksDir = path.join(root, 'subtasks');
  await fs.mkdir(subtasksDir, { recursive: true });
  await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
  for (const [id, record] of Object.entries(records)) {
    await fs.writeFile(path.join(subtasksDir, `${id}.json`), JSON.stringify(record), 'utf-8');
  }
}

describe('transition state machine', () => {
  it('starts a verification attempt from todo', () => {
    const existing = makeTodoRecord('t1');
    const transition: VerificationAttemptTransition = {
      kind: 'start',
      attemptId: 'a1',
      evidence: 'ev',
      artifacts: ['art1'],
      at: '2026-07-19T10:00:00Z',
    };

    const result = applyVerificationAttemptTransition(existing, transition);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('verifying');
    expect(result.record.current_attempt_id).toBe('a1');
    expect(result.record.evidence).toBe('ev');
    expect(result.record.artifacts).toEqual(['art1']);
    expect(result.record.attempts).toHaveLength(1);
    expect(result.record.attempts[0]).toEqual({
      id: 'a1',
      status: 'running',
      started_at: '2026-07-19T10:00:00Z',
      evidence: 'ev',
      artifacts: ['art1'],
    });
  });

  it('does not modify the input record', () => {
    const existing = makeTodoRecord('t1');
    const before = JSON.stringify(existing);
    applyVerificationAttemptTransition(existing, {
      kind: 'start',
      attemptId: 'a1',
      evidence: 'ev',
      artifacts: [],
      at: '2026-07-19T10:00:00Z',
    });
    expect(JSON.stringify(existing)).toBe(before);
  });

  it('rejects start when subtask is not todo', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'start',
      attemptId: 'a2',
      evidence: 'ev',
      artifacts: [],
      at: '2026-07-19T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects start with duplicate attempt id', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'start',
      attemptId: 'a1',
      evidence: 'ev',
      artifacts: [],
      at: '2026-07-19T10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('passes a running attempt and completes the subtask', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      evidence: 'ev',
      artifacts: ['art1'],
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: ['art1'],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'pass',
      attemptId: 'a1',
      at: '2026-07-19T10:05:00Z',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.completed_at).toBe('2026-07-19T10:05:00Z');
    expect(result.record.current_attempt_id).toBeUndefined();
    expect(result.record.attempts[0].status).toBe('passed');
    expect(result.record.attempts[0].finished_at).toBe('2026-07-19T10:05:00Z');
  });

  it('rejects a running attempt and resets to todo', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      evidence: 'ev',
      artifacts: [],
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'reject',
      attemptId: 'a1',
      at: '2026-07-19T10:05:00Z',
      feedback: 'too vague',
      cause: 'llm_rejected',
      forceAccept: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('todo');
    expect(result.record.completed_at).toBeUndefined();
    expect(result.record.current_attempt_id).toBeUndefined();
    expect(result.record.attempts[0].status).toBe('rejected');
    expect(result.record.attempts[0].feedback).toBe('too vague');
    expect(result.record.attempts[0].cause).toBe('llm_rejected');
  });

  it('force-accepts a rejected attempt and completes the subtask', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      evidence: 'ev',
      artifacts: [],
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'reject',
      attemptId: 'a1',
      at: '2026-07-19T10:05:00Z',
      feedback: 'still vague',
      cause: 'llm_rejected',
      forceAccept: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.completed_at).toBe('2026-07-19T10:05:00Z');
    expect(result.record.force_accepted).toBe(true);
    expect(result.record.attempts[0].status).toBe('rejected');
  });

  it('interrupts a running attempt and resets to todo without retry', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      evidence: 'ev',
      artifacts: [],
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'interrupt',
      attemptId: 'a1',
      at: '2026-07-19T10:05:00Z',
      cause: 'daemon_restart',
      feedback: 'daemon restarted',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('todo');
    expect(result.record.current_attempt_id).toBeUndefined();
    expect(result.record.attempts[0].status).toBe('interrupted');
    expect(result.record.attempts[0].cause).toBe('daemon_restart');
    expect(result.record.attempts[0].feedback).toBe('daemon restarted');
  });

  it('rejects pass when attempt id mismatches (ABA guard)', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a1',
      attempts: [{
        id: 'a1',
        status: 'running',
        started_at: '2026-07-19T10:00:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'pass',
      attemptId: 'a0',
      at: '2026-07-19T10:05:00Z',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toContain('expected attempt a1, got a0');
  });

  it('rejects terminal transition when subtask is not verifying', () => {
    const existing = makeTodoRecord('t1');
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'pass',
      attemptId: 'a1',
      at: '2026-07-19T10:05:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects repeated pass on the same attempt', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'completed',
      completed_at: '2026-07-19T10:05:00Z',
      evidence: 'ev',
      artifacts: [],
      attempts: [{
        id: 'a1',
        status: 'passed',
        started_at: '2026-07-19T10:00:00Z',
        finished_at: '2026-07-19T10:05:00Z',
        evidence: 'ev',
        artifacts: [],
      }],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'pass',
      attemptId: 'a1',
      at: '2026-07-19T10:06:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('keeps prior attempts intact across transitions', () => {
    const existing: SubtaskRuntimeRecord = {
      ...makeTodoRecord('t1'),
      status: 'verifying',
      current_attempt_id: 'a2',
      evidence: 'ev2',
      artifacts: [],
      attempts: [
        {
          id: 'a1',
          status: 'rejected',
          started_at: '2026-07-19T10:00:00Z',
          finished_at: '2026-07-19T10:01:00Z',
          evidence: 'ev1',
          artifacts: [],
          feedback: 'bad',
          cause: 'llm_rejected',
        },
        {
          id: 'a2',
          status: 'running',
          started_at: '2026-07-19T10:02:00Z',
          evidence: 'ev2',
          artifacts: [],
        },
      ],
    };
    const result = applyVerificationAttemptTransition(existing, {
      kind: 'pass',
      attemptId: 'a2',
      at: '2026-07-19T10:05:00Z',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.attempts).toHaveLength(2);
    expect(result.record.attempts[0].status).toBe('rejected');
    expect(result.record.attempts[1].status).toBe('passed');
  });
});

describe('current repository', () => {
  it('commits a start transition to disk', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const { audit } = makeAudit();

    const result = await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't1',
      {
        kind: 'start',
        attemptId: 'a1',
        evidence: 'ev',
        artifacts: ['art1'],
        at: '2026-07-19T10:00:00Z',
      },
    );

    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') return;
    expect(result.record.status).toBe('verifying');

    const filePath = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't1.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('verifying');
    expect(parsed.current_attempt_id).toBe('a1');
  });

  it('skips transition for unknown subtask and writes nothing', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const filePath = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't1.json');
    const before = await fs.readFile(filePath, 'utf-8');
    const { audit } = makeAudit();

    const result = await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't2',
      {
        kind: 'start',
        attemptId: 'a1',
        evidence: 'ev',
        artifacts: [],
        at: '2026-07-19T10:00:00Z',
      },
    );

    expect(result.kind).toBe('skipped');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('skips transition when contract id mismatches', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const { audit } = makeAudit();

    await expect(
      transitionCurrentVerificationAttempt(
        { fs: nodeFs, audit },
        'cid-2' as any,
        't1',
        {
          kind: 'start',
          attemptId: 'a1',
          evidence: 'ev',
          artifacts: [],
          at: '2026-07-19T10:00:00Z',
        },
      ),
    ).rejects.toThrow('contract id mismatch');
  });

  it('only modifies the target subtask file', async () => {
    await writeCurrentLayout(
      makeContract([{ id: 't1', description: 'D1' }, { id: 't2', description: 'D2' }]),
      { t1: makeTodoRecord('t1'), t2: makeTodoRecord('t2') },
    );
    const t2Path = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't2.json');
    const before = await fs.readFile(t2Path, 'utf-8');
    const { audit } = makeAudit();

    await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't1',
      {
        kind: 'start',
        attemptId: 'a1',
        evidence: 'ev',
        artifacts: [],
        at: '2026-07-19T10:00:00Z',
      },
    );

    const after = await fs.readFile(t2Path, 'utf-8');
    expect(after).toBe(before);
  });
});
