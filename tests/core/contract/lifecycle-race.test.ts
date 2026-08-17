/**
 * Phase 1198 Step D: terminal lifecycle race matrix.
 *
 * Uses two ContractSystem instances sharing the same filesystem.
 * A filesystem barrier coordinates the two callers so they enter their
 * terminal commit at roughly the same time, without relying on sleep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import type { ContractNotification } from '../../../src/core/contract/notification.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { readLifecycleIntentsForContract } from '../../../src/core/contract/lifecycle-intent.js';
import { archiveAndEmit } from '../../../src/core/contract/verification-lifecycle.js';
import { createManagerVerificationContext } from '../../helpers/contract-subtask.js';
import type { ArchiveState, LifecycleCommitOutcome } from '../../../src/core/contract/types.js';

// Poll cadence for the filesystem barrier: short enough to keep race tests
// fast, long enough to avoid busy-looping the shared tmpdir under CI load.
const BARRIER_POLL_INTERVAL_MS = 5;
// Peer-wait ceiling: barrier partners are released on the same tick, so any
// wait beyond this means a hung racer, not slow I/O.
const BARRIER_PEER_TIMEOUT_MS = 5_000;

async function makeBarrier(baseDir: string, name: string) {
  const readyA = path.join(baseDir, `.barrier-${name}-a-ready`);
  const readyB = path.join(baseDir, `.barrier-${name}-b-ready`);

  return {
    async arrive(role: 'a' | 'b') {
      const readyFile = role === 'a' ? readyA : readyB;
      const peerReady = role === 'a' ? readyB : readyA;
      await fs.writeFile(readyFile, role, 'utf-8');
      const deadline = Date.now() + BARRIER_PEER_TIMEOUT_MS;
      while (!(await fileExists(peerReady))) {
        if (Date.now() > deadline) throw new Error('barrier peer timeout');
        await new Promise(r => setTimeout(r, BARRIER_POLL_INTERVAL_MS));
      }
    },
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface RaceFixture {
  tempDir: string;
  clawDir: string;
  managerA: ContractSystem;
  managerB: ContractSystem;
  notifyA: ContractNotification[];
  notifyB: ContractNotification[];
}

async function setupRace(): Promise<RaceFixture> {
  const tempDir = await createTempDir('phase1198-race-');
  const clawDir = path.join(tempDir, 'claws', 'race-claw');
  await fs.mkdir(clawDir, { recursive: true });

  const notifyA: ContractNotification[] = [];
  const notifyB: ContractNotification[] = [];

  const makeManager = () => {
    const manager = new ContractSystem({
      clawDir,
      clawId: 'race-claw',
      fs: new NodeFileSystem({ baseDir: clawDir }),
      audit: { write: () => {} } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: path.join(tempDir, 'claws'),
      notifyClaw: () => Promise.resolve(),
    });
    return manager;
  };

  const managerA = makeManager();
  const managerB = makeManager();
  managerA.setOnNotify((event) => notifyA.push(event));
  managerB.setOnNotify((event) => notifyB.push(event));

  return { tempDir, clawDir, managerA, managerB, notifyA, notifyB };
}

async function teardownRace(fixture: RaceFixture) {
  await cleanupTempDir(fixture.tempDir);
}

async function resolveFinalArchiveState(
  clawDir: string,
  contractId: string,
): Promise<ArchiveState | null> {
  for (const state of ['completed', 'cancelled', 'corrupted', 'failed'] as ArchiveState[]) {
    const statePath = path.join(clawDir, 'contract', 'archive', state, contractId);
    if (await fileExists(statePath)) return state;
  }
  return null;
}

describe('Phase 1198 Step D: terminal lifecycle races', () => {
  let fx: RaceFixture;

  beforeEach(async () => {
    fx = await setupRace();
  });

  afterEach(async () => {
    await teardownRace(fx);
  });

  async function assertSingleArchive(contractId: string, expectedState: ArchiveState) {
    const activePath = path.join(fx.clawDir, 'contract', 'active', contractId);
    await expect(fs.access(activePath)).rejects.toBeTruthy();

    for (const state of ['completed', 'cancelled', 'corrupted', 'failed'] as ArchiveState[]) {
      const statePath = path.join(fx.clawDir, 'contract', 'archive', state, contractId);
      if (state === expectedState) {
        await expect(fs.access(statePath)).resolves.toBeUndefined();
      } else {
        await expect(fs.access(statePath)).rejects.toBeTruthy();
      }
    }
  }

  async function assertBothIntentsPreserved(contractId: string, expectedStates: ArchiveState[]) {
    const clawFs = new NodeFileSystem({ baseDir: fx.clawDir });
    const { intents } = await readLifecycleIntentsForContract(
      clawFs,
      { write: () => {} } as any,
      fx.clawDir,
      contractId as any,
    );
    expect(intents.length).toBe(2);
    const states = intents.map(i => i.requested_state).sort();
    expect(states).toEqual(expectedStates.slice().sort());
    return intents;
  }

  /** Result shape returned by `archiveAndEmit`. */
  interface ArchiveResult {
    archived: boolean;
    state?: ArchiveState;
  }

  type RaceOutcome = LifecycleCommitOutcome | ArchiveResult | void;

  function isCommitOutcome(v: RaceOutcome): v is LifecycleCommitOutcome {
    return typeof v === 'object' && v !== null && 'kind' in v;
  }

  function isArchiveResult(v: RaceOutcome): v is ArchiveResult {
    return typeof v === 'object' && v !== null && 'archived' in v;
  }

  /**
   * Race two terminal operations and verify the shared invariants.
   *
   * `runA`/`runB` must each return either a `LifecycleCommitOutcome` or an
   * archive result shape `{ archived: boolean; state?: ArchiveState }` (e.g.
   * `archiveAndEmit`). The caller supplies the two intent states and a predicate
   * that checks side-effect counts from the notify callbacks.
   */
  async function runRace(
    contractId: string,
    runA: () => Promise<RaceOutcome>,
    runB: () => Promise<RaceOutcome>,
    intentStates: [ArchiveState, ArchiveState],
    assertSideEffects: (finalState: ArchiveState) => void,
  ) {
    const [resultA, resultB] = await Promise.allSettled([runA(), runB()]);
    const outA = resultA.status === 'fulfilled' ? resultA.value : undefined;
    const outB = resultB.status === 'fulfilled' ? resultB.value : undefined;

    const finalState = await resolveFinalArchiveState(fx.clawDir, contractId);
    expect(finalState).not.toBeNull();

    await assertSingleArchive(contractId, finalState!);
    await assertBothIntentsPreserved(contractId, intentStates);

    const explicitOutcomes: LifecycleCommitOutcome[] = [];
    const archiveResults: ArchiveResult[] = [];
    for (const out of [outA, outB]) {
      if (isCommitOutcome(out)) {
        explicitOutcomes.push(out);
      } else if (isArchiveResult(out)) {
        archiveResults.push(out);
      }
    }

    const committed = explicitOutcomes.filter(o => o.kind === 'committed');
    const archiveCommitted = archiveResults.filter(r => r.archived);
    const nonCommitted = explicitOutcomes.filter(o => o.kind !== 'committed');

    // At most one caller can observe a fresh commit.
    expect(committed.length + archiveCommitted.length).toBeLessThanOrEqual(1);

    // Any explicit non-commit must be a normal race result, not a retryable failure.
    for (const o of nonCommitted) {
      expect(['already_committed', 'lost_to_state']).toContain(o.kind);
    }

    // Determine the winner. The discriminated union narrows by `kind` alone;
    // no field-level type assertion is needed anywhere below.
    if (committed.length === 1) {
      expect(committed[0].state).toBe(finalState);
    } else if (archiveCommitted.length === 1) {
      expect(archiveCommitted[0].state ?? finalState).toBe(finalState);
    } else if (explicitOutcomes.length === 1) {
      const only = explicitOutcomes[0];
      if (only.kind !== 'lost_to_state') {
        throw new Error(`expected lost_to_state loser, got ${only.kind}`);
      }
      expect(only.committed).toBe(finalState);
    } else if (archiveResults.length === 1) {
      const only = archiveResults[0];
      expect(only.archived).toBe(false);
      expect(only.state).toBe(finalState);
    } else {
      throw new Error('Cannot determine winner: no explicit outcomes');
    }

    assertSideEffects(finalState!);
  }

  it('cancel vs cancel: exactly one archive, both intents preserved, one notify', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Cancel',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const barrier = await makeBarrier(fx.tempDir, 'cancel-cancel');

    await runRace(
      contractId,
      async () => { await barrier.arrive('a'); return fx.managerA.cancel(contractId as any, 'cancel A'); },
      async () => { await barrier.arrive('b'); return fx.managerB.cancel(contractId as any, 'cancel B'); },
      ['cancelled', 'cancelled'],
      () => {
        const allNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_cancelled');
        expect(allNotifies).toHaveLength(1);
      },
    );
  });

  it('cancel vs completed: winner decides archive state, only winner side effect', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Cancel Completed',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    const progress = await fx.managerA.getProgress(contractId as any);
    progress!.subtasks.t1.status = 'completed';
    progress!.subtasks.t1.completed_at = new Date().toISOString();
    progress!.subtasks.t2.status = 'completed';
    progress!.subtasks.t2.completed_at = new Date().toISOString();
    await (fx.managerA as any).saveActiveProgressExisting(contractId as any, progress);

    const barrier = await makeBarrier(fx.tempDir, 'cancel-completed');

    await runRace(
      contractId,
      async () => { await barrier.arrive('a'); return fx.managerA.cancel(contractId as any, 'cancel A'); },
      async () => {
        await barrier.arrive('b');
        const ctx = createManagerVerificationContext(fx.managerB);
        const yaml = await ctx.loadContractYaml(contractId as any);
        if (!yaml) throw new Error('missing contract yaml');
        return archiveAndEmit(ctx, contractId as any, yaml, 'race.completed');
      },
      ['cancelled', 'completed'],
      (finalState) => {
        const completedNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_completed');
        const cancelledNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_cancelled');
        if (finalState === 'completed') {
          expect(completedNotifies).toHaveLength(1);
          expect(cancelledNotifies).toHaveLength(0);
        } else {
          expect(completedNotifies).toHaveLength(0);
          expect(cancelledNotifies).toHaveLength(1);
        }
      },
    );
  });

  it('cancel vs corrupted: winner decides archive state, only winner side effect', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Cancel Corrupted',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const barrier = await makeBarrier(fx.tempDir, 'cancel-corrupted');

    await runRace(
      contractId,
      async () => { await barrier.arrive('a'); return fx.managerA.cancel(contractId as any, 'cancel A'); },
      async () => {
        await barrier.arrive('b');
        return fx.managerB.markCorrupted(contractId as any, {
          reason: 'progress_schema_invalid',
          relativePath: 'corrupted/race_progress.json',
        });
      },
      ['cancelled', 'corrupted'],
      (finalState) => {
        const cancelledNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_cancelled');
        if (finalState === 'cancelled') {
          expect(cancelledNotifies).toHaveLength(1);
        } else {
          expect(cancelledNotifies).toHaveLength(0);
        }
      },
    );
  });

  it('completed vs corrupted: winner decides archive state, only winner side effect', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Completed Corrupted',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    const progress = await fx.managerA.getProgress(contractId as any);
    progress!.subtasks.t1.status = 'completed';
    progress!.subtasks.t1.completed_at = new Date().toISOString();
    progress!.subtasks.t2.status = 'completed';
    progress!.subtasks.t2.completed_at = new Date().toISOString();
    await (fx.managerA as any).saveActiveProgressExisting(contractId as any, progress);

    const barrier = await makeBarrier(fx.tempDir, 'completed-corrupted');

    await runRace(
      contractId,
      async () => {
        await barrier.arrive('a');
        const ctx = createManagerVerificationContext(fx.managerA);
        const yaml = await ctx.loadContractYaml(contractId as any);
        if (!yaml) throw new Error('missing contract yaml');
        return archiveAndEmit(ctx, contractId as any, yaml, 'race.completed');
      },
      async () => {
        await barrier.arrive('b');
        return fx.managerB.markCorrupted(contractId as any, {
          reason: 'progress_schema_invalid',
          relativePath: 'corrupted/race_progress.json',
        });
      },
      ['completed', 'corrupted'],
      (finalState) => {
        const completedNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_completed');
        if (finalState === 'completed') {
          expect(completedNotifies).toHaveLength(1);
        } else {
          expect(completedNotifies).toHaveLength(0);
        }
      },
    );
  });

  it('completed vs completed: exactly one success side-effect set, both intents preserved', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Completed Completed',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    const progress = await fx.managerA.getProgress(contractId as any);
    progress!.subtasks.t1.status = 'completed';
    progress!.subtasks.t1.completed_at = new Date().toISOString();
    progress!.subtasks.t2.status = 'completed';
    progress!.subtasks.t2.completed_at = new Date().toISOString();
    await (fx.managerA as any).saveActiveProgressExisting(contractId as any, progress);

    const barrier = await makeBarrier(fx.tempDir, 'completed-completed');

    await runRace(
      contractId,
      async () => {
        await barrier.arrive('a');
        const ctx = createManagerVerificationContext(fx.managerA);
        const yaml = await ctx.loadContractYaml(contractId as any);
        if (!yaml) throw new Error('missing contract yaml');
        return archiveAndEmit(ctx, contractId as any, yaml, 'race.completed');
      },
      async () => {
        await barrier.arrive('b');
        const ctx = createManagerVerificationContext(fx.managerB);
        const yaml = await ctx.loadContractYaml(contractId as any);
        if (!yaml) throw new Error('missing contract yaml');
        return archiveAndEmit(ctx, contractId as any, yaml, 'race.completed');
      },
      ['completed', 'completed'],
      () => {
        const completedNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_completed');
        expect(completedNotifies).toHaveLength(1);
      },
    );
  });

  const RACE_FAILURE = {
    reason: 'executor process died',
    evidenceRef: 'executor/events.jsonl#seq=42',
    producer: 'event-loop',
  };

  it('Phase 1396 Step D: fail vs cancel: exactly one archive winner, only winner side effect', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Fail Cancel',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const barrier = await makeBarrier(fx.tempDir, 'fail-cancel');

    await runRace(
      contractId,
      async () => { await barrier.arrive('a'); return fx.managerA.fail(contractId as any, RACE_FAILURE); },
      async () => { await barrier.arrive('b'); return fx.managerB.cancel(contractId as any, 'cancel B'); },
      ['failed', 'cancelled'],
      (finalState) => {
        const failedNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_failed');
        const cancelledNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_cancelled');
        if (finalState === 'failed') {
          expect(failedNotifies).toHaveLength(1);
          expect(cancelledNotifies).toHaveLength(0);
        } else {
          expect(failedNotifies).toHaveLength(0);
          expect(cancelledNotifies).toHaveLength(1);
        }
      },
    );
  });

  it('Phase 1396 Step D: fail vs completed: winner decides archive state, only winner side effect', async () => {
    const contractId = await fx.managerA.create(makeContractYaml({
      title: 'Race Fail Completed',
      goal: 'Test',
      subtasks: [
        { id: 't1', description: 'T1' },
        { id: 't2', description: 'T2' },
      ],
      verification: [],
    }));

    const progress = await fx.managerA.getProgress(contractId as any);
    progress!.subtasks.t1.status = 'completed';
    progress!.subtasks.t1.completed_at = new Date().toISOString();
    progress!.subtasks.t2.status = 'completed';
    progress!.subtasks.t2.completed_at = new Date().toISOString();
    await (fx.managerA as any).saveActiveProgressExisting(contractId as any, progress);

    const barrier = await makeBarrier(fx.tempDir, 'fail-completed');

    await runRace(
      contractId,
      async () => { await barrier.arrive('a'); return fx.managerA.fail(contractId as any, RACE_FAILURE); },
      async () => {
        await barrier.arrive('b');
        const ctx = createManagerVerificationContext(fx.managerB);
        const yaml = await ctx.loadContractYaml(contractId as any);
        if (!yaml) throw new Error('missing contract yaml');
        return archiveAndEmit(ctx, contractId as any, yaml, 'race.completed');
      },
      ['failed', 'completed'],
      (finalState) => {
        const failedNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_failed');
        const completedNotifies = [...fx.notifyA, ...fx.notifyB].filter(n => n.type === 'contract_completed');
        if (finalState === 'failed') {
          expect(failedNotifies).toHaveLength(1);
          expect(completedNotifies).toHaveLength(0);
        } else {
          expect(failedNotifies).toHaveLength(0);
          expect(completedNotifies).toHaveLength(1);
        }
      },
    );
  });
});
