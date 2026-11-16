/** Phase 2178: persistent candidate admission, crash windows, and convergence evidence. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  admitWatchdogCandidate,
  inspectWatchdogRecoveryWindow,
  listWatchdogRecoveryWindows,
  recordWatchdogCandidateSpawned,
  type WatchdogCandidateAdmission,
} from '../../src/watchdog/candidate-recovery.js';
import {
  commitOwnership,
  newWatchdogAttempt,
  prepareCandidate,
  retireOwnership,
  writeCandidateOutcome,
  WATCHDOG_ACTIVE_DIR,
  WATCHDOG_CANDIDATES_DIR,
  type WatchdogOwnerRecord,
} from '../../src/watchdog/watchdog-ownership.js';

let tmpDir: string;
let chestnutDir: string;
let chestnutFs: NodeFileSystem;

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  tmpDir = path.join(os.tmpdir(), `wd-candidate-recovery-${randomUUID()}`);
  chestnutDir = path.join(tmpDir, '.chestnut');
  fs.mkdirSync(chestnutDir, { recursive: true });
  chestnutFs = new NodeFileSystem({ baseDir: chestnutDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function admittedRecord(admission: WatchdogCandidateAdmission, pid = process.pid): WatchdogOwnerRecord {
  return {
    ...newWatchdogAttempt(pid),
    attempt_id: admission.attemptId,
    recovery_window_id: admission.windowId,
  };
}

function candidateOutcomes(): Array<Record<string, unknown>> {
  const dir = path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((entry) => path.join(dir, entry, 'outcome.json'))
    .filter((entry) => fs.existsSync(entry))
    .map((entry) => JSON.parse(fs.readFileSync(entry, 'utf8')) as Record<string, unknown>);
}

describe('watchdog candidate recovery windows', () => {
  it('admission 后、spawn 前崩溃：fresh instance 保留 slot/count，预算不重置', () => {
    const first = admitWatchdogCandidate(chestnutFs, null, { budget: 2, nowMs: 1_000 });
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    expect(first.window).toMatchObject({ candidateCount: 1, state: 'open' });

    // No child and no candidate owner: the durable admission itself is the crash fact.
    const freshFs = new NodeFileSystem({ baseDir: chestnutDir });
    const second = admitWatchdogCandidate(freshFs, null, { budget: 2, nowMs: 2_000 });
    expect(second.kind).toBe('admitted');
    if (second.kind !== 'admitted') return;
    expect(second.admission.attemptId).not.toBe(first.admission.attemptId);
    expect(second.window).toMatchObject({
      candidateCount: 2,
      lastCandidateAtMs: 2_000,
      state: 'exhausted',
    });

    const third = admitWatchdogCandidate(new NodeFileSystem({ baseDir: chestnutDir }), null, {
      budget: 2,
      nowMs: 3_000,
    });
    expect(third.kind).toBe('rejected');
    if (third.kind === 'rejected') expect(third.reason).toBe('budget_exhausted');
    expect(inspectWatchdogRecoveryWindow(freshFs, first.admission.windowId).candidateCount).toBe(2);
    const rejection = path.join(
      chestnutDir,
      'watchdog',
      'recovery',
      'rejections',
      first.admission.windowId,
      `${third.kind === 'rejected' ? third.attemptId : 'missing'}.json`,
    );
    expect(JSON.parse(fs.readFileSync(rejection, 'utf8'))).toMatchObject({
      kind: 'rejected',
      reason: 'budget_exhausted',
      candidateCount: 2,
    });
  });

  it('spawn 后、active rename 前崩溃：spawn evidence 与 candidate 均可重建', () => {
    const admitted = admitWatchdogCandidate(chestnutFs, null, { budget: 2, nowMs: 1_000 });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const owner = admittedRecord(admitted.admission);
    prepareCandidate(chestnutFs, owner);
    recordWatchdogCandidateSpawned(chestnutFs, owner);

    const freshFs = new NodeFileSystem({ baseDir: chestnutDir });
    const recovered = inspectWatchdogRecoveryWindow(freshFs, admitted.admission.windowId);
    expect(recovered).toMatchObject({ candidateCount: 1, state: 'open' });
    const spawned = JSON.parse(fs.readFileSync(path.join(
      chestnutDir,
      'watchdog',
      'recovery',
      'windows',
      admitted.admission.windowId,
      'attempts',
      String(admitted.admission.slot),
      'spawned.json',
    ), 'utf8'));
    expect(spawned).toMatchObject({
      kind: 'spawned',
      attemptId: owner.attempt_id,
      pid: process.pid,
    });
    expect(fs.existsSync(path.join(
      chestnutDir,
      WATCHDOG_CANDIDATES_DIR,
      owner.attempt_id,
      'owner.json',
    ))).toBe(true);
  });

  it('active rename 后、winner marker 前崩溃：fresh summary 从 active 恢复 winner_committed', () => {
    const admitted = admitWatchdogCandidate(chestnutFs, null, { budget: 3, nowMs: 1_000 });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const winner = admittedRecord(admitted.admission);
    prepareCandidate(chestnutFs, winner);

    // Deliberately bypass commitOwnership: rename committed, marker did not run.
    chestnutFs.moveDirSync(
      `${WATCHDOG_CANDIDATES_DIR}/${winner.attempt_id}`,
      WATCHDOG_ACTIVE_DIR,
    );

    const freshFs = new NodeFileSystem({ baseDir: chestnutDir });
    expect(inspectWatchdogRecoveryWindow(freshFs, admitted.admission.windowId)).toMatchObject({
      candidateCount: 1,
      state: 'winner_committed',
      winnerAttemptId: winner.attempt_id,
    });
  });

  it('winner/loser/retire 守恒：迟到 loser 不改窗口，stale recovery 关闭旧 epoch', () => {
    const first = admitWatchdogCandidate(chestnutFs, null, { budget: 3, nowMs: 1_000 });
    const second = admitWatchdogCandidate(chestnutFs, null, { budget: 3, nowMs: 2_000 });
    expect(first.kind).toBe('admitted');
    expect(second.kind).toBe('admitted');
    if (first.kind !== 'admitted' || second.kind !== 'admitted') return;
    const winner = admittedRecord(first.admission);
    const loser = admittedRecord(second.admission);
    prepareCandidate(chestnutFs, winner);
    prepareCandidate(chestnutFs, loser);
    expect(commitOwnership(chestnutFs, winner).kind).toBe('committed');
    const lost = commitOwnership(chestnutFs, loser);
    expect(lost.kind).toBe('foreign_owned');
    if (lost.kind !== 'foreign_owned') return;
    writeCandidateOutcome(chestnutFs, loser.attempt_id, {
      outcome: 'lost',
      winner_owner_token: lost.owner.owner_token,
      winner_attempt_id: lost.owner.attempt_id,
      winner_pid: lost.owner.pid,
      reason: 'active_collision',
    });

    expect(candidateOutcomes()).toHaveLength(1);
    expect(candidateOutcomes()[0]).toMatchObject({
      outcome: 'lost',
      window_id: first.admission.windowId,
      winner_attempt_id: winner.attempt_id,
    });
    expect(listWatchdogRecoveryWindows(chestnutFs)).toHaveLength(1);
    expect(inspectWatchdogRecoveryWindow(chestnutFs, first.admission.windowId).state).toBe('winner_committed');

    expect(retireOwnership(chestnutFs, {
      attemptId: winner.attempt_id,
      ownerToken: winner.owner_token,
      pid: winner.pid,
    }, 'stale_recovery').kind).toBe('retired');
    expect(inspectWatchdogRecoveryWindow(chestnutFs, first.admission.windowId)).toMatchObject({
      state: 'closed',
      candidateCount: 2,
      winnerAttemptId: winner.attempt_id,
    });
    expect(candidateOutcomes()).toHaveLength(1);
    expect(listWatchdogRecoveryWindows(chestnutFs)).toHaveLength(1);
  });
});
