import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { NodeFileSystem, type AtomicWriteResult } from '../../../src/foundation/fs/index.js';
import {
  captureCurrentProcessRef,
  type ProcessRefObservation,
} from '../../../src/foundation/process-exec/index.js';
import { createSubagentRunner } from '../../../src/core/subagent/execution-reference.js';
import type { SubagentExecutionView } from '../../../src/core/subagent/execution-types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

class InjectingFileSystem extends NodeFileSystem {
  constructor(baseDir: string, private readonly failStop: boolean) {
    super({ baseDir });
  }

  override async writeAtomic(recordPath: string, content: string): Promise<AtomicWriteResult> {
    if (this.failStop && recordPath.includes('/stops/.')) throw new Error('injected stop intent write failure');
    return super.writeAtomic(recordPath, content);
  }
}

function evidence() {
  const captured = captureCurrentProcessRef();
  if (captured.kind !== 'captured') throw new Error('test host ProcessRef capture unavailable');
  return captured.evidence;
}

function inspecting(kind: ProcessRefObservation['kind']) {
  return {
    captureCurrentProcessRef,
    inspectProcessRef: (): ProcessRefObservation => {
      if (kind === 'alive') return { kind, evidence: evidence() };
      if (kind === 'gone') return { kind, reason: 'absent', evidence: evidence() };
      return { kind, reason: 'query_failed', evidence: evidence() };
    },
  };
}

describe('Phase 2248 Step C execution references', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
    tempDir = undefined;
  });

  async function setup(tag: string) {
    tempDir = await createTrackedTempDir(`chestnut-exec-ref-${tag}-`);
    const fs = new NodeFileSystem({ baseDir: tempDir });
    return { fs, resultDir: 'results/run', runId: 'run-a' };
  }

  it('normalizes identity, joins duplicate start and keeps open read-only', async () => {
    const { fs, resultDir } = await setup('open');
    const runner = createSubagentRunner({ fs });
    const ref = await runner.start({ runId: ' run-a ', resultDir: './results/run/', input: { prompt: 'same' } });
    expect(ref.identity).toMatchObject({ runId: 'run-a', resultDir: 'results/run' });
    expect(ref.identity.attemptId).not.toBe('run-a');

    const duplicate = await createSubagentRunner({ fs }).start({ runId: 'run-a', resultDir, input: { prompt: 'same' } });
    expect(duplicate).toBe(ref);
    await expect(runner.start({ runId: 'run-a', resultDir, input: { prompt: 'different' } }))
      .rejects.toMatchObject({ kind: 'conflict' });

    const before = await fs.list(resultDir, { recursive: true, includeDirs: true });
    const observation = await runner.open({ runId: ' run-a ', resultDir: './results/run/' });
    expect(observation.kind).toBe('found');
    if (observation.kind === 'found') expect(observation.owner).toBe('alive');
    const after = await fs.list(resultDir, { recursive: true, includeDirs: true });
    expect(after.map(entry => `${entry.path}:${entry.size}`)).toEqual(before.map(entry => `${entry.path}:${entry.size}`));
    expect((await ref.read()).state).toBe('prepared');
  });

  it('registers observers before reading, de-duplicates sequences and replays terminal outcomes', async () => {
    const { fs, resultDir, runId } = await setup('observe');
    const observerErrors: unknown[] = [];
    const runner = createSubagentRunner({ fs, onObserverError: error => { observerErrors.push(error); } });
    const ref = await runner.start({ runId, resultDir, input: { prompt: 'observe' } });
    const sequences: number[] = [];
    ref.observe(view => { sequences.push(view.sequence); });
    const other: string[] = [];
    ref.observe(view => { other.push(view.state); });
    ref.observe(() => { throw new Error('observer boom'); });

    await ref.transition({ state: 'running' });
    const final = await ref.settle({ kind: 'completed', content: 'done', rawResult: { text: 'done' } });
    expect(await ref.completion).toBe(final);
    expect(sequences).toEqual([1, 2, 3, 4]);
    expect(other.at(-1)).toBe('settled');
    expect(observerErrors.length).toBeGreaterThan(0);

    const late = await runner.open({ runId, resultDir, attemptId: ref.identity.attemptId });
    expect(late.kind).toBe('found');
    if (late.kind !== 'found') throw new Error('expected terminal observation');
    expect(late.owner).toBe('settled');
    const replay: SubagentExecutionView[] = [];
    late.ref.observe(view => { replay.push(view); });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ state: 'settled', outcome: { content: 'done' } });
    await late.ref.read();
    expect(replay).toHaveLength(1);
  });

  it('returns durable stop evidence before completion and exposes stop write failure', async () => {
    const { fs, resultDir, runId } = await setup('stop');
    const runner = createSubagentRunner({ fs });
    const ref = await runner.start({ runId, resultDir, input: { prompt: 'stop' } });
    let completed = false;
    void ref.completion.then(() => { completed = true; });

    const reason = { type: 'user_abort', detail: 'caller stopped waiting' };
    const receipt = await ref.requestStop(reason);
    expect(receipt).toMatchObject({ accepted: true, state: 'stopping', persisted: true, durable: true, reason });
    expect(completed).toBe(false);
    const stopRecord = await fs.read(path.join(resultDir, 'execution/attempts/1/stops/1.json'));
    expect(JSON.parse(stopRecord)).toMatchObject({ schema_version: 1, kind: 'subagent_stop_requested', reason });
    await ref.settle({ kind: 'interrupted', content: 'actually stopped', cause: reason });

    await cleanupTempDir(tempDir!);
    tempDir = await createTrackedTempDir('chestnut-exec-ref-stop-failure-');
    const failingFs = new InjectingFileSystem(tempDir, true);
    const failing = await createSubagentRunner({ fs: failingFs }).start({
      runId: 'stop-failure', resultDir: 'results/other', input: { prompt: 'stop' },
    });
    const failed = await failing.requestStop({ type: 'user_abort' });
    expect(failed).toMatchObject({ accepted: true, persisted: false, durable: false });
    expect(failed.persistence.error).toContain('injected stop intent write failure');
    expect(failed.state).toBe('stopping');
  });

  it('forbids alive/unknown takeover and lets concurrent resume losers attach the winner', async () => {
    const { fs, resultDir, runId } = await setup('owner');
    const alive = createSubagentRunner({ fs, process: inspecting('alive') });
    const first = await alive.start({ runId, resultDir, input: { prompt: 'resume' } });
    await expect(alive.resume({ runId, resultDir, input: { prompt: 'resume' }, previousAttemptId: first.identity.attemptId }))
      .rejects.toMatchObject({ kind: 'owner_unavailable' });
    expect(await fs.exists(path.join(resultDir, 'execution/attempts/2/claim.json'))).toBe(false);

    const unknownRunner = createSubagentRunner({ fs, process: inspecting('unknown') });
    const unknown = await unknownRunner.open({ runId, resultDir });
    expect(unknown.kind).toBe('owner_unavailable');
    await expect(unknownRunner.resume({ runId, resultDir, input: { prompt: 'resume' }, previousAttemptId: first.identity.attemptId }))
      .rejects.toMatchObject({ kind: 'owner_unavailable' });

    const gone = createSubagentRunner({ fs, process: inspecting('gone'), newAttemptId: () => 'opaque-successor' });
    const successors = await Promise.all([
      gone.resume({ runId, resultDir, input: { prompt: 'resume' }, previousAttemptId: first.identity.attemptId }),
      gone.resume({ runId, resultDir, input: { prompt: 'resume' }, previousAttemptId: first.identity.attemptId }),
    ]);
    expect(successors[0]).toBe(successors[1]);
    expect(successors[0].identity.attemptId).toBe('opaque-successor');
    expect(successors[0].identity.attemptId).not.toBe(first.identity.attemptId);
    expect(successors[0].ownsClaim).toBe(true);
    const claim = JSON.parse(await fs.read(path.join(resultDir, 'execution/attempts/2/claim.json')));
    expect(claim).toMatchObject({
      parentAttemptId: first.identity.attemptId,
      startBasis: { kind: 'resume', previousAttemptId: first.identity.attemptId },
    });
  });

  it('distinguishes not_found, legacy and corrupt observations', async () => {
    const { fs, resultDir, runId } = await setup('missing');
    const runner = createSubagentRunner({ fs });
    expect(await runner.open({ runId, resultDir })).toMatchObject({ kind: 'not_found' });

    await fs.writeAtomic(path.join(resultDir, 'recovery/cursor.json'), JSON.stringify({ schema_version: 1, kind: 'legacy' }));
    expect(await runner.open({ runId, resultDir })).toMatchObject({
      kind: 'legacy', artifacts: ['recovery/cursor.json'],
    });

    const ref = await runner.start({ runId, resultDir, input: { prompt: 'new protocol' } });
    const claimPath = path.join(resultDir, 'execution/attempts/1/claim.json');
    await fs.writeAtomic(claimPath, '{not-json');
    expect(await runner.open({ runId, resultDir, attemptId: ref.identity.attemptId })).toMatchObject({
      kind: 'corrupt', path: claimPath,
    });
    expect(await fs.read(claimPath)).toBe('{not-json');
    await expect(runner.resume({
      runId, resultDir, input: { prompt: 'new protocol' }, previousAttemptId: ref.identity.attemptId,
    })).rejects.toMatchObject({ kind: 'corrupt' });
    expect(await fs.exists(path.join(resultDir, 'execution/attempts/2/claim.json'))).toBe(false);
  });

  it('refuses initial admission when the host ProcessRef capture is gone or unknown', async () => {
    const { fs, resultDir, runId } = await setup('capture');
    for (const captureKind of ['gone', 'unknown'] as const) {
      const runner = createSubagentRunner({
        fs,
        process: {
          captureCurrentProcessRef: () => captureKind === 'gone'
            ? { kind: 'gone', evidence: evidence() }
            : { kind: 'unknown', reason: 'query_failed', evidence: evidence() },
          inspectProcessRef: () => ({ kind: 'unknown', reason: 'query_failed', evidence: evidence() }),
        },
      });
      await expect(runner.start({
        runId: `${runId}-${captureKind}`, resultDir: `${resultDir}-${captureKind}`, input: { prompt: 'no claim' },
      })).rejects.toMatchObject({ kind: 'owner_unavailable' });
      expect(await fs.exists(path.join(`${resultDir}-${captureKind}`, 'execution/attempts/1/claim.json'))).toBe(false);
    }
  });

  it('does not complete merely because stop was requested', async () => {
    const { fs, resultDir, runId } = await setup('completion');
    const ref = await createSubagentRunner({ fs }).start({ runId, resultDir, input: null });
    const settled = vi.fn();
    void ref.completion.then(settled);
    await ref.requestStop('stop now');
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(settled).not.toHaveBeenCalled();
    await ref.settle({ kind: 'interrupted', content: 'real terminal', recovery: 'uncertain_side_effect' });
    expect(settled).toHaveBeenCalledOnce();
  });
});
