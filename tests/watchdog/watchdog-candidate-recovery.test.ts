/** Phase 2178: persistent candidate admission, crash windows, and convergence evidence. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import {
  admitWatchdogCandidate,
  inspectWatchdogRecoveryWindow,
  listWatchdogRecoveryWindows,
  readWatchdogCandidateAdmission,
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

const LONG_WINDOW_ID = `recovery-after-${'w'.repeat(220)}`;

function windowPath(windowId: string): string {
  return path.join(chestnutDir, 'watchdog', 'recovery', 'windows', windowId);
}

function shaId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function seedWindow(
  windowId: string,
  generation: number,
  budget = 2,
  predecessor?: { kind: 'attempt' | 'window'; id: string },
): void {
  fs.mkdirSync(windowPath(windowId), { recursive: true });
  fs.writeFileSync(path.join(windowPath(windowId), 'window.json'), JSON.stringify({
    schemaVersion: predecessor ? 2 : 1,
    windowId,
    openedAtMs: 1_000 + generation,
    generation,
    budget,
    state: 'open',
    ...(predecessor ? { predecessor } : {}),
  }, null, 2));
}

function seedCommittedAdmission(windowId: string, slot: number): WatchdogCandidateAdmission {
  const admission: WatchdogCandidateAdmission = {
    schemaVersion: 1,
    attemptId: `${windowId}-candidate-${slot}`,
    windowId,
    slot,
    admittedAtMs: 1_000 + slot,
    callerPid: process.pid,
  };
  const serialized = JSON.stringify(admission, null, 2);
  const slotDir = path.join(windowPath(windowId), 'attempts', String(slot));
  const candidateDir = path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, admission.attemptId);
  fs.mkdirSync(slotDir, { recursive: true });
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, 'admission.json'), serialized);
  fs.writeFileSync(path.join(candidateDir, 'admission.json'), serialized);
  return admission;
}

function seedWinner(windowId: string, attemptId: string): void {
  fs.writeFileSync(path.join(windowPath(windowId), 'winner.json'), JSON.stringify({ attemptId }));
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

  it('长旧 open 窗口用有界新 attempt 消耗剩余槽，exhausted 与重启读取不改旧记录', () => {
    seedWindow(LONG_WINDOW_ID, 8, 2);
    const old = seedCommittedAdmission(LONG_WINDOW_ID, 0);
    const oldMirror = path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, old.attemptId, 'admission.json');
    const oldBytes = fs.readFileSync(oldMirror);

    const admitted = admitWatchdogCandidate(chestnutFs, null, { budget: 4, nowMs: 2_000 });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    expect(admitted.admission).toMatchObject({ windowId: LONG_WINDOW_ID, slot: 1 });
    expect(admitted.admission.attemptId).toMatch(/^ca2-[a-f0-9]{64}$/);
    expect(Buffer.byteLength(admitted.admission.attemptId, 'utf8')).toBe(68);
    expect(admitted.window).toMatchObject({ candidateCount: 2, budget: 2, state: 'exhausted' });

    const freshFs = new NodeFileSystem({ baseDir: chestnutDir });
    expect(readWatchdogCandidateAdmission(freshFs, old.attemptId)).toEqual(old);
    expect(readWatchdogCandidateAdmission(freshFs, admitted.admission.attemptId)).toEqual(admitted.admission);
    expect(fs.readFileSync(oldMirror)).toEqual(oldBytes);
    const rejected = admitWatchdogCandidate(freshFs, null, { budget: 4, nowMs: 3_000 });
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'budget_exhausted' });
    expect(fs.readdirSync(path.join(windowPath(LONG_WINDOW_ID), 'attempts')).sort()).toEqual(['0', '1']);
  });

  it('同 ID candidate mirror 冲突时显式失败并保留已消费槽', () => {
    seedWindow(LONG_WINDOW_ID, 8, 1);
    const attemptId = shaId('ca2', [LONG_WINDOW_ID, 0]);
    const candidateDir = path.join(chestnutDir, WATCHDOG_CANDIDATES_DIR, attemptId);
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(candidateDir, 'admission.json'), JSON.stringify({
      schemaVersion: 1,
      attemptId,
      windowId: LONG_WINDOW_ID,
      slot: 0,
      admittedAtMs: 999,
      callerPid: process.pid,
    }));

    expect(() => admitWatchdogCandidate(chestnutFs, null, { nowMs: 2_000 }))
      .toThrow(/mirror conflict/);
    const committed = JSON.parse(fs.readFileSync(
      path.join(windowPath(LONG_WINDOW_ID), 'attempts', '0', 'admission.json'), 'utf8'));
    expect(committed).toMatchObject({ attemptId, admittedAtMs: 2_000 });
    expect(inspectWatchdogRecoveryWindow(chestnutFs, LONG_WINDOW_ID).candidateCount).toBe(1);
  });

  it('latest winner 从第 8 代真实长路径续接有界 rw2，旧记录保持原字节', () => {
    seedWindow(LONG_WINDOW_ID, 8, 2);
    const old = seedCommittedAdmission(LONG_WINDOW_ID, 0);
    seedWinner(LONG_WINDOW_ID, old.attemptId);
    const oldSeed = fs.readFileSync(path.join(windowPath(LONG_WINDOW_ID), 'window.json'));

    const next = admitWatchdogCandidate(chestnutFs, null, { nowMs: 4_000 });
    expect(next.kind).toBe('admitted');
    if (next.kind !== 'admitted') return;
    const predecessor = { kind: 'attempt', id: old.attemptId };
    expect(next.admission.windowId).toBe(shaId('rw2', ['attempt', old.attemptId]));
    expect(Buffer.byteLength(next.admission.windowId, 'utf8')).toBe(68);
    expect(next.admission.attemptId).toBe(`${next.admission.windowId}-candidate-0`);
    expect(Buffer.byteLength(next.admission.attemptId, 'utf8')).toBe(80);
    expect(next.window).toMatchObject({ generation: 9, candidateCount: 1 });
    const seed = JSON.parse(fs.readFileSync(
      path.join(windowPath(next.admission.windowId), 'window.json'), 'utf8'));
    expect(seed).toMatchObject({ schemaVersion: 2, generation: 9, predecessor });
    expect(fs.readFileSync(path.join(windowPath(LONG_WINDOW_ID), 'window.json'))).toEqual(oldSeed);
    expect(readWatchdogCandidateAdmission(new NodeFileSystem({ baseDir: chestnutDir }), old.attemptId))
      .toEqual(old);
  });

  it('stale owner 长代际链每代均有界且 v2 predecessor 可审计', () => {
    seedWindow(LONG_WINDOW_ID, 8, 2);
    let previous = seedCommittedAdmission(LONG_WINDOW_ID, 0);

    for (let generation = 9; generation <= 12; generation++) {
      const freshFs = new NodeFileSystem({ baseDir: chestnutDir });
      const next = admitWatchdogCandidate(freshFs, {
        attempt_id: previous.attemptId,
        owner_token: `token-${generation}`,
        pid: 999999999,
        recovery_window_id: previous.windowId,
      }, { nowMs: generation * 1_000 });
      expect(next.kind).toBe('admitted');
      if (next.kind !== 'admitted') return;
      expect(next.admission.windowId).toBe(shaId('rw2', ['attempt', previous.attemptId]));
      expect(next.admission.windowId).toHaveLength(68);
      expect(next.window.generation).toBe(generation);
      const seed = JSON.parse(fs.readFileSync(
        path.join(windowPath(next.admission.windowId), 'window.json'), 'utf8'));
      expect(seed.predecessor).toEqual({ kind: 'attempt', id: previous.attemptId });
      previous = next.admission;
    }
  });

  it('旧 open 后继沿用原槽位预算，重启后续用剩余槽', () => {
    const parentId = 'recovery-initial';
    seedWindow(parentId, 1, 2);
    const parentAttempt = seedCommittedAdmission(parentId, 0);
    seedWinner(parentId, parentAttempt.attemptId);
    const legacyId = `recovery-after-${parentAttempt.attemptId}`;
    seedWindow(legacyId, 2, 2);
    const old = seedCommittedAdmission(legacyId, 0);
    const oldBytes = fs.readFileSync(path.join(
      windowPath(legacyId), 'attempts', '0', 'admission.json'));

    const next = admitWatchdogCandidate(chestnutFs, {
      attempt_id: parentAttempt.attemptId,
      owner_token: 'old-token',
      pid: 999999999,
      recovery_window_id: parentId,
    }, { budget: 4, nowMs: 5_000 });
    expect(next.kind).toBe('admitted');
    if (next.kind !== 'admitted') return;
    expect(next.admission).toMatchObject({ windowId: legacyId, slot: 1 });
    expect(next.window).toMatchObject({ budget: 2, candidateCount: 2, state: 'exhausted' });
    expect(fs.readFileSync(path.join(windowPath(legacyId), 'attempts', '0', 'admission.json')))
      .toEqual(oldBytes);
    expect(readWatchdogCandidateAdmission(new NodeFileSystem({ baseDir: chestnutDir }), old.attemptId))
      .toEqual(old);
  });

  it('已完成旧后继作为父代续接新 rw2，不改旧 winner 事实', () => {
    const parentId = 'recovery-initial';
    seedWindow(parentId, 1, 2);
    const parentAttempt = seedCommittedAdmission(parentId, 0);
    seedWinner(parentId, parentAttempt.attemptId);
    const legacyId = `recovery-after-${parentAttempt.attemptId}`;
    seedWindow(legacyId, 2, 2);
    const legacyWinner = seedCommittedAdmission(legacyId, 0);
    seedWinner(legacyId, legacyWinner.attemptId);
    const oldWinner = fs.readFileSync(path.join(windowPath(legacyId), 'winner.json'));

    const next = admitWatchdogCandidate(chestnutFs, null, { nowMs: 6_000 });
    expect(next.kind).toBe('admitted');
    if (next.kind !== 'admitted') return;
    expect(next.admission.windowId).toBe(shaId('rw2', ['attempt', legacyWinner.attemptId]));
    expect(next.window.generation).toBe(3);
    expect(fs.readFileSync(path.join(windowPath(legacyId), 'winner.json'))).toEqual(oldWinner);
  });

  it('闭窗无 winner 以后继 window predecessor 创建有界窗口', () => {
    const parentId = 'recovery-initial';
    seedWindow(parentId, 3, 2);
    fs.writeFileSync(path.join(windowPath(parentId), 'closed.json'), JSON.stringify({ reason: 'test' }));

    const next = admitWatchdogCandidate(chestnutFs, null, { nowMs: 7_000 });
    expect(next.kind).toBe('admitted');
    if (next.kind !== 'admitted') return;
    expect(next.admission.windowId).toBe(shaId('rw2', ['window', parentId]));
    const seed = JSON.parse(fs.readFileSync(
      path.join(windowPath(next.admission.windowId), 'window.json'), 'utf8'));
    expect(seed).toMatchObject({
      generation: 4,
      predecessor: { kind: 'window', id: parentId },
    });
  });

  it('旧/新后继分流与半成品窗口均拒绝，不发放第二份预算', () => {
    const parentId = 'recovery-initial';
    seedWindow(parentId, 1, 2);
    const parentAttempt = seedCommittedAdmission(parentId, 0);
    seedWinner(parentId, parentAttempt.attemptId);
    const predecessor = { kind: 'attempt' as const, id: parentAttempt.attemptId };
    const legacyId = `recovery-after-${parentAttempt.attemptId}`;
    const boundedId = shaId('rw2', ['attempt', parentAttempt.attemptId]);
    seedWindow(legacyId, 2, 2);
    seedWindow(boundedId, 2, 2, predecessor);
    const staleOwner = {
      attempt_id: parentAttempt.attemptId,
      owner_token: 'old-token',
      pid: 999999999,
      recovery_window_id: parentId,
    };

    expect(() => admitWatchdogCandidate(chestnutFs, staleOwner)).toThrow(/successor divergence/);
    expect(() => admitWatchdogCandidate(chestnutFs, null)).toThrow(/successor divergence/);
    expect(fs.existsSync(path.join(windowPath(legacyId), 'attempts', '1'))).toBe(false);
    expect(fs.existsSync(path.join(windowPath(boundedId), 'attempts', '0'))).toBe(false);

    fs.rmSync(windowPath(legacyId), { recursive: true });
    fs.rmSync(windowPath(boundedId), { recursive: true });
    fs.mkdirSync(windowPath(boundedId), { recursive: true });
    expect(() => admitWatchdogCandidate(chestnutFs, staleOwner)).toThrow(/Incomplete.*window/);
    expect(fs.existsSync(path.join(windowPath(boundedId), 'attempts'))).toBe(false);

    fs.rmSync(windowPath(boundedId), { recursive: true });
    seedWindow(legacyId, 3, 2);
    expect(() => admitWatchdogCandidate(chestnutFs, staleOwner)).toThrow(/generation mismatch/);
    expect(fs.existsSync(windowPath(boundedId))).toBe(false);
  });

  it('legacy seed 可读后 attempts 的 ENAMETOOLONG 不得伪装成旧路径不可寻址', () => {
    const parentId = 'recovery-initial';
    seedWindow(parentId, 1, 2);
    const parentAttempt = seedCommittedAdmission(parentId, 0);
    seedWinner(parentId, parentAttempt.attemptId);
    const legacyId = `recovery-after-${parentAttempt.attemptId}`;
    const boundedId = shaId('rw2', ['attempt', parentAttempt.attemptId]);
    seedWindow(legacyId, 2, 2);
    const attemptsPath = path.join('watchdog', 'recovery', 'windows', legacyId, 'attempts');
    class AttemptReadErrorFs extends NodeFileSystem {
      override listSync(
        relativePath: string,
        options?: { recursive?: boolean; includeDirs?: boolean; pattern?: string },
      ): ReturnType<NodeFileSystem['listSync']> {
        if (relativePath === attemptsPath) {
          throw Object.assign(new Error('legacy attempts name too long'), { code: 'ENAMETOOLONG' });
        }
        return super.listSync(relativePath, options);
      }
    }

    expect(() => admitWatchdogCandidate(new AttemptReadErrorFs({ baseDir: chestnutDir }), {
      attempt_id: parentAttempt.attemptId,
      owner_token: 'old-token',
      pid: 999999999,
      recovery_window_id: parentId,
    })).toThrow(/legacy attempts name too long/);
    expect(fs.existsSync(windowPath(boundedId))).toBe(false);
  });

  it('生产 rename 输家核对同一 v2 前代并沿用赢家预算', () => {
    const parentId = 'recovery-initial';
    seedWindow(parentId, 1, 2);
    const parentAttempt = seedCommittedAdmission(parentId, 0);
    const predecessor = { kind: 'attempt' as const, id: parentAttempt.attemptId };
    const successorId = shaId('rw2', ['attempt', parentAttempt.attemptId]);
    let raced = false;
    class RenameRaceFs extends NodeFileSystem {
      override moveDirSync(fromPath: string, toPath: string): void {
        if (!raced && fromPath.includes('.opening-')) {
          raced = true;
          seedWindow(successorId, 2, 2, predecessor);
        }
        super.moveDirSync(fromPath, toPath);
      }
    }

    const result = admitWatchdogCandidate(new RenameRaceFs({ baseDir: chestnutDir }), {
      attempt_id: parentAttempt.attemptId,
      owner_token: 'old-token',
      pid: 999999999,
      recovery_window_id: parentId,
    }, { budget: 4, nowMs: 9_000 });
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(raced).toBe(true);
    expect(result.admission.windowId).toBe(successorId);
    expect(result.window).toMatchObject({ budget: 2, openedAtMs: 1_002, candidateCount: 1 });
  });

  it('initial rename 输家拒绝意外 v2 seed，不消费损坏窗口预算', () => {
    let raced = false;
    class InitialRenameRaceFs extends NodeFileSystem {
      override moveDirSync(fromPath: string, toPath: string): void {
        if (!raced && fromPath.includes('.opening-')) {
          raced = true;
          seedWindow('recovery-initial', 0, 2, { kind: 'window', id: 'unexpected-parent' });
        }
        super.moveDirSync(fromPath, toPath);
      }
    }

    expect(() => admitWatchdogCandidate(new InitialRenameRaceFs({ baseDir: chestnutDir }), null))
      .toThrow(/seed version mismatch/);
    expect(raced).toBe(true);
    expect(fs.existsSync(path.join(windowPath('recovery-initial'), 'attempts'))).toBe(false);
  });
});
