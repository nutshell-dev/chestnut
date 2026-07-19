/**
 * Phase 1136: verification attempt transition state machine and gateway tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit, waitForAuditEvent } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  applyVerificationAttemptTransition,
  transitionCurrentVerificationAttempt,
  readCurrentContractLayout,
} from '../../../src/core/contract/new-layout.js';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord } from '../../../src/core/contract/types.js';
import type { VerificationAttemptTransition } from '../../../src/core/contract/verification-transition-types.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

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

  it('rejects with programming_bug and timeout causes', () => {
    for (const cause of ['programming_bug', 'subagent_timeout'] as const) {
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
        kind: 'reject',
        attemptId: 'a1',
        at: '2026-07-19T10:01:00Z',
        feedback: 'bad',
        cause,
        forceAccept: false,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.record.attempts[0].cause).toBe(cause);
    }
  });

  it('interrupts without incrementing retry count', () => {
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
      kind: 'interrupt',
      attemptId: 'a1',
      at: '2026-07-19T10:01:00Z',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('todo');
    expect(result.record.attempts[0].status).toBe('interrupted');
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

  it('returns late and writes nothing when terminal attempt id mismatches (ABA guard)', async () => {
    await writeCurrentLayout(makeContract(), {
      t1: {
        ...makeTodoRecord('t1'),
        status: 'verifying',
        current_attempt_id: 'a2',
        attempts: [{
          id: 'a1',
          status: 'rejected',
          started_at: '2026-07-19T10:00:00Z',
          finished_at: '2026-07-19T10:01:00Z',
          evidence: 'ev',
          artifacts: [],
          feedback: 'bad',
          cause: 'llm_rejected',
        }, {
          id: 'a2',
          status: 'running',
          started_at: '2026-07-19T10:02:00Z',
          evidence: 'ev',
          artifacts: [],
        }],
      },
    });
    const filePath = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't1.json');
    const before = await fs.readFile(filePath, 'utf-8');
    const { audit } = makeAudit();

    const result = await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't1',
      {
        kind: 'pass',
        attemptId: 'a1',
        at: '2026-07-19T10:05:00Z',
      },
    );

    expect(result.kind).toBe('late');
    if (result.kind !== 'late') return;
    expect(result.expectedAttemptId).toBe('a2');
    expect(result.actualAttemptId).toBe('a1');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(before);
  });

  it.each([
    { kind: 'reject', feedback: 'bad', cause: 'llm_rejected', forceAccept: false },
    { kind: 'interrupt' },
  ] as const)('returns late for terminal $kind when current attempt id mismatches', async (transition) => {
    await writeCurrentLayout(makeContract(), {
      t1: {
        ...makeTodoRecord('t1'),
        status: 'verifying',
        current_attempt_id: 'a2',
        attempts: [{
          id: 'a1',
          status: 'rejected',
          started_at: '2026-07-19T10:00:00Z',
          finished_at: '2026-07-19T10:01:00Z',
          evidence: 'ev',
          artifacts: [],
          feedback: 'bad',
          cause: 'llm_rejected',
        }, {
          id: 'a2',
          status: 'running',
          started_at: '2026-07-19T10:02:00Z',
          evidence: 'ev',
          artifacts: [],
        }],
      },
    });
    const filePath = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't1.json');
    const before = await fs.readFile(filePath, 'utf-8');
    const { audit } = makeAudit();

    const result = await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't1',
      {
        ...transition,
        attemptId: 'a1',
        at: '2026-07-19T10:05:00Z',
      } as VerificationAttemptTransition,
    );

    expect(result.kind).toBe('late');
    if (result.kind !== 'late') return;
    expect(result.expectedAttemptId).toBe('a2');
    expect(result.actualAttemptId).toBe('a1');
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('skips terminal transition when subtask status is not verifying (no late)', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const filePath = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't1.json');
    const before = await fs.readFile(filePath, 'utf-8');
    const { audit } = makeAudit();

    const result = await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't1',
      { kind: 'pass', attemptId: 'a0', at: '2026-07-19T10:05:00Z' },
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

  it('only modifies the target subtask file on start', async () => {
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

  it('only modifies the target subtask file on pass', async () => {
    await writeCurrentLayout(
      makeContract([{ id: 't1', description: 'D1' }, { id: 't2', description: 'D2' }]),
      {
        t1: {
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
        },
        t2: makeTodoRecord('t2'),
      },
    );
    const t2Path = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't2.json');
    const before = await fs.readFile(t2Path, 'utf-8');
    const { audit } = makeAudit();

    await transitionCurrentVerificationAttempt(
      { fs: nodeFs, audit },
      'cid-1' as any,
      't1',
      {
        kind: 'pass',
        attemptId: 'a1',
        at: '2026-07-19T10:05:00Z',
      },
    );

    const after = await fs.readFile(t2Path, 'utf-8');
    expect(after).toBe(before);
  });
});

function setupManager(clawDirOverride: string) {
  const { audit, events, emitter } = makeAudit();
  const manager = new ContractSystem({
    clawDir: clawDirOverride,
    clawId: 'test-claw',
    fs: new NodeFileSystem({ baseDir: clawDirOverride }),
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory,
    notifyClaw: vi.fn(),
  });
  return { manager, audit, events, emitter };
}

describe('verification gateway', () => {
  it('recognizes current layout as active', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const { manager } = setupManager(clawDir);

    const active = await manager.isActiveContract('cid-1' as any);
    expect(active).toBe(true);
  });

  it('returns false for non-existent contract', async () => {
    const { manager } = setupManager(clawDir);
    const active = await manager.isActiveContract('missing' as any);
    expect(active).toBe(false);
  });

  it('returns current root without duplicated contract id', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const { manager } = setupManager(clawDir);

    const root = await manager.getContractRoot('cid-1' as any);
    expect(root).toBe('contract/active/current');
  });

  it('commits transition through gateway and returns progress projection', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const { manager } = setupManager(clawDir);

    const result = await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
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
    expect(result.progress.subtasks.t1.status).toBe('in_progress');
    expect(result.progress.subtasks.t1.verification_attempt_id).toBe('a1');
  });

  it('returns late when current attempt id mismatches through gateway', async () => {
    await writeCurrentLayout(makeContract(), {
      t1: {
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
      },
    });
    const { manager } = setupManager(clawDir);

    const result = await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
      {
        kind: 'pass',
        attemptId: 'a0',
        at: '2026-07-19T10:05:00Z',
      },
    );

    expect(result.kind).toBe('late');
    if (result.kind !== 'late') return;
    expect(result.expectedAttemptId).toBe('a1');
    expect(result.actualAttemptId).toBe('a0');
  });

  it('does not fallback to legacy when current is corrupted', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    // Corrupt current by removing yaml.
    await fs.rm(path.join(clawDir, 'contract', 'active', 'current', 'contract.yaml'));
    // Also create legacy active with same id.
    const legacyRoot = path.join(clawDir, 'contract', 'active', 'cid-1');
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(
      path.join(legacyRoot, 'progress.json'),
      JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'todo' } } }),
      'utf-8',
    );
    const { manager } = setupManager(clawDir);

    await expect(manager.isActiveContract('cid-1' as any)).rejects.toThrow();
  });
});

describe('verification gateway legacy parity', () => {
  async function writeLegacyLayout(contractId: string) {
    const root = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, 'contract.yaml'),
      yaml.dump(makeContract()),
      'utf-8',
    );
    await fs.writeFile(
      path.join(root, 'progress.json'),
      JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'todo' } } }),
      'utf-8',
    );
  }

  it('start transition projects same progress fields as current', async () => {
    await writeLegacyLayout('cid-1');
    const { manager } = setupManager(clawDir);

    const result = await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
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
    expect(result.progress.subtasks.t1.status).toBe('in_progress');
    expect(result.progress.subtasks.t1.verification_attempt_id).toBe('a1');
    expect(result.progress.subtasks.t1.evidence).toBe('ev');
  });

  it('reject transition increments retry_count and resets to todo', async () => {
    await writeLegacyLayout('cid-1');
    const { manager } = setupManager(clawDir);
    await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
      {
        kind: 'start',
        attemptId: 'a1',
        evidence: 'ev',
        artifacts: [],
        at: '2026-07-19T10:00:00Z',
      },
    );

    const result = await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
      {
        kind: 'reject',
        attemptId: 'a1',
        at: '2026-07-19T10:01:00Z',
        feedback: 'bad',
        cause: 'script_failed',
        forceAccept: false,
      },
    );

    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') return;
    expect(result.progress.subtasks.t1.status).toBe('todo');
    expect(result.progress.subtasks.t1.retry_count).toBe(1);
    expect(result.progress.subtasks.t1.last_failed_feedback).toEqual({
      feedback: 'bad',
      cause: 'script_failed',
    });
  });

  it('keeps skipped for legacy attempt id mismatch', async () => {
    await writeLegacyLayout('cid-1');
    const { manager } = setupManager(clawDir);
    await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
      {
        kind: 'start',
        attemptId: 'a2',
        evidence: 'ev',
        artifacts: [],
        at: '2026-07-19T10:00:00Z',
      },
    );

    const result = await manager.transitionVerificationAttempt(
      'cid-1' as any,
      't1' as any,
      {
        kind: 'pass',
        attemptId: 'a1',
        at: '2026-07-19T10:01:00Z',
      },
    );

    expect(result.kind).toBe('skipped');
  });
});

describe('daemon restart interruption', () => {
  it('boot reconcile interrupts verifying attempts with daemon_restart cause', async () => {
    await writeCurrentLayout(makeContract(), {
      t1: {
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
      },
    });
    const { manager, audit, events } = setupManager(clawDir);

    await manager.init();

    const resetEvent = events.find(
      e => e[0] === CONTRACT_AUDIT_EVENTS.BOOT_RECONCILE_IN_PROGRESS_RESET,
    );
    expect(resetEvent).toBeDefined();
    expect(resetEvent?.some(col => String(col).includes('cause=daemon_restart'))).toBe(true);

    const filePath = path.join(clawDir, 'contract', 'active', 'current', 'subtasks', 't1.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('todo');
    expect(parsed.attempts[0].status).toBe('interrupted');
    expect(parsed.attempts[0].cause).toBe('daemon_restart');
  });
});

describe('current verification end to end', () => {
  async function writeCurrentContractWithVerification(
    contract: PersistedContractYaml,
    records: Record<string, SubtaskRuntimeRecord>,
    scripts: Record<string, string>,
  ) {
    const root = path.join(clawDir, 'contract', 'active', 'current');
    const subtasksDir = path.join(root, 'subtasks');
    const verificationDir = path.join(root, 'verification');
    await fs.mkdir(subtasksDir, { recursive: true });
    await fs.mkdir(verificationDir, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
    for (const [id, record] of Object.entries(records)) {
      await fs.writeFile(path.join(subtasksDir, `${id}.json`), JSON.stringify(record), 'utf-8');
    }
    for (const [name, content] of Object.entries(scripts)) {
      const scriptPath = path.join(verificationDir, name);
      await fs.writeFile(scriptPath, content, 'utf-8');
      await fs.chmod(scriptPath, 0o755);
    }
  }

  it('start leaves running attempt and uses contract/active/current root', async () => {
    const contract = {
      ...makeContract(),
      verification: [{ subtask_id: 't1', type: 'script' as const, script_file: 'verification/t1.sh' }],
    };
    await writeCurrentContractWithVerification(
      contract,
      { t1: makeTodoRecord('t1') },
      { 't1.sh': '#!/bin/sh\nexit 0\n' },
    );
    const { manager, events, emitter } = setupManager(clawDir);

    const result = await manager.completeSubtask({
      contractId: 'cid-1' as any,
      subtaskId: 't1' as any,
      evidence: 'ev',
    });

    expect(result.async).toBe(true);
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED);

    const layout = await readCurrentContractLayout({ fs: nodeFs, audit: makeAudit().audit });
    expect(layout).not.toBeNull();
    const record = layout!.subtasks.get('t1')!;
    expect(record.status).toBe('completed');
    expect(record.attempts[0].status).toBe('passed');
    expect(record.attempts[0].evidence).toBe('ev');
  });

  it('reject preserves first attempt history for second start', async () => {
    const contract = {
      ...makeContract(),
      verification_attempts: 2,
      verification: [{ subtask_id: 't1', type: 'script' as const, script_file: 'verification/t1.sh' }],
    };
    await writeCurrentContractWithVerification(
      contract,
      { t1: makeTodoRecord('t1') },
      { 't1.sh': '#!/bin/sh\nexit 1\necho fail\n' },
    );
    const { manager, events, emitter } = setupManager(clawDir);

    // First attempt fails and resets to todo.
    let result = await manager.completeSubtask({
      contractId: 'cid-1' as any,
      subtaskId: 't1' as any,
      evidence: 'ev1',
    });
    expect(result.async).toBe(true);
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_RESET_TO_TODO);

    let layout = await readCurrentContractLayout({ fs: nodeFs, audit: makeAudit().audit });
    let record = layout!.subtasks.get('t1')!;
    expect(record.status).toBe('todo');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0].status).toBe('rejected');

    // Second attempt passes (swap script to success).
    const scriptPath = path.join(clawDir, 'contract', 'active', 'current', 'verification', 't1.sh');
    await fs.writeFile(scriptPath, '#!/bin/sh\nexit 0\n', 'utf-8');
    result = await manager.completeSubtask({
      contractId: 'cid-1' as any,
      subtaskId: 't1' as any,
      evidence: 'ev2',
    });
    expect(result.async).toBe(true);
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED);

    layout = await readCurrentContractLayout({ fs: nodeFs, audit: makeAudit().audit });
    record = layout!.subtasks.get('t1')!;
    expect(record.status).toBe('completed');
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts[0].status).toBe('rejected');
    expect(record.attempts[1].status).toBe('passed');
  });

  it('force-accepts after max attempts and preserves rejected attempt', async () => {
    const contract = {
      ...makeContract(),
      verification_attempts: 1,
      verification: [{ subtask_id: 't1', type: 'script' as const, script_file: 'verification/t1.sh' }],
    };
    await writeCurrentContractWithVerification(
      contract,
      { t1: makeTodoRecord('t1') },
      { 't1.sh': '#!/bin/sh\nexit 1\n' },
    );
    const { manager, events, emitter } = setupManager(clawDir);

    const result = await manager.completeSubtask({
      contractId: 'cid-1' as any,
      subtaskId: 't1' as any,
      evidence: 'ev',
    });
    expect(result.async).toBe(true);
    await waitForAuditEvent(emitter, events, CONTRACT_AUDIT_EVENTS.SUBTASK_FORCE_ACCEPTED);

    const layout = await readCurrentContractLayout({ fs: nodeFs, audit: makeAudit().audit });
    const record = layout!.subtasks.get('t1')!;
    expect(record.status).toBe('completed');
    expect(record.force_accepted).toBe(true);
    expect(record.attempts[0].status).toBe('rejected');
  });
});
