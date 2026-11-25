import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { NodeFileSystem, type AtomicWriteResult } from '../../../src/foundation/fs/index.js';
import {
  createSubagentExecutionStore,
  SubagentExecutionStoreError,
} from '../../../src/core/subagent/execution-store.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

class InjectingFileSystem extends NodeFileSystem {
  constructor(
    baseDir: string,
    private readonly inject: (
      recordPath: string,
      write: () => Promise<AtomicWriteResult>,
    ) => Promise<AtomicWriteResult>,
  ) {
    super({ baseDir });
  }

  override writeAtomic(recordPath: string, content: string): Promise<AtomicWriteResult> {
    return this.inject(recordPath, () => super.writeAtomic(recordPath, content));
  }
}

describe('Phase 2248 Step C execution store', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
    tempDir = undefined;
  });

  async function setup(tag: string, fs?: NodeFileSystem) {
    tempDir = await createTrackedTempDir(`chestnut-exec-store-${tag}-`);
    const filesystem = fs ?? new NodeFileSystem({ baseDir: tempDir });
    const resultDir = 'results/run';
    const location = { runId: 'run-a', resultDir };
    const left = createSubagentExecutionStore({ fs: filesystem, resultDir, newAttemptId: () => 'opaque-left' });
    const right = createSubagentExecutionStore({ fs: filesystem, resultDir, newAttemptId: () => 'opaque-right' });
    return { fs: filesystem, location, left, right };
  }

  async function prepareBoth(
    left: ReturnType<typeof createSubagentExecutionStore>,
    right: ReturnType<typeof createSubagentExecutionStore>,
    location: { runId: string; resultDir: string },
  ) {
    const input = { prompt: 'persist me', config: { b: 2, a: 1 } };
    await left.prepareInput(location, input);
    await right.prepareInput(location, { config: { a: 1, b: 2 }, prompt: 'persist me' });
    return (await left.prepareInput(location, input)).document;
  }

  it('publishes one complete claim under concurrent no-replace admission', async () => {
    const { fs, location, left, right } = await setup('claim-race');
    const input = await prepareBoth(left, right, location);

    const results = await Promise.all([
      left.claimAttempt({ location, inputDigest: input.inputDigest, ordinal: 1, parentAttemptId: null, startBasis: 'start' }),
      right.claimAttempt({ location, inputDigest: input.inputDigest, ordinal: 1, parentAttemptId: null, startBasis: 'start' }),
    ]);

    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'existing')).toHaveLength(1);
    const claim = results[0].kind === 'claimed' ? results[0].claim : results[1].kind === 'claimed' ? results[1].claim : undefined;
    expect(claim).toBeDefined();
    const raw = await fs.read(path.join(location.resultDir, 'execution/attempts/1/claim.json'));
    const persisted = JSON.parse(raw);
    expect(persisted).toMatchObject({
      schema_version: 1,
      runId: location.runId,
      ordinal: 1,
      attemptId: claim!.attemptId,
      inputDigest: input.inputDigest,
      owner: { kind: 'captured' },
      startBasis: { kind: 'start' },
    });
    expect(persisted.owner.processRef).toEqual(expect.any(String));
    expect(persisted.owner.evidence).toBeDefined();
    expect(raw).not.toBe('');
  });

  it('re-reads identical input and rejects different input without replacing the original', async () => {
    const { fs, location, left } = await setup('input');
    const original = await left.prepareInput(location, { prompt: 'original', nested: { x: 1 } });
    const before = await fs.read(left.inputPath);

    const same = await left.prepareInput(location, { nested: { x: 1 }, prompt: 'original' });
    expect(same.document.inputDigest).toBe(original.document.inputDigest);
    expect(same.persistence).toBeUndefined();

    await expect(left.prepareInput(location, { prompt: 'different', nested: { x: 1 } }))
      .rejects.toMatchObject({ kind: 'conflict' });
    expect(await fs.read(left.inputPath)).toBe(before);
    expect(JSON.parse(before).input.prompt).toBe('original');
  });

  it('preserves and reports an empty/corrupt claim instead of taking it over', async () => {
    const { fs, location, left, right } = await setup('corrupt');
    const input = await prepareBoth(left, right, location);
    const claimed = await left.claimAttempt({ location, inputDigest: input.inputDigest, ordinal: 1, parentAttemptId: null, startBasis: 'start' });
    if (claimed.kind !== 'claimed') throw new Error('expected claim winner');
    const claimPath = path.join(location.resultDir, 'execution/attempts/1/claim.json');
    await fs.writeAtomic(claimPath, '');

    const read = await right.read(location.runId);
    expect(read.kind).toBe('corrupt');
    expect(await fs.read(claimPath)).toBe('');
    await expect(right.latestClaim(location.runId)).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('rebuilds state from a committed event when the snapshot write fails', async () => {
    const holder: { fs?: InjectingFileSystem } = {};
    tempDir = await createTrackedTempDir('chestnut-exec-store-state-failure-');
    const filesystem = new InjectingFileSystem(tempDir, async (recordPath, write) => {
      if (recordPath.endsWith('/state.json')) throw new Error('injected state snapshot failure');
      return write();
    });
    holder.fs = filesystem;
    const store = createSubagentExecutionStore({ fs: filesystem, resultDir: 'results/run' });
    const location = { runId: 'run-a', resultDir: 'results/run' };
    const input = await store.prepareInput(location, { prompt: 'x' });
    const claimed = await store.claimAttempt({ location, inputDigest: input.document.inputDigest, ordinal: 1, parentAttemptId: null, startBasis: 'start' });
    if (claimed.kind !== 'claimed') throw new Error('expected claim');
    await claimed.writer.transition({ state: 'prepared' });

    const transition = await claimed.writer.transition({ state: 'running', reason: { step: 1 } });
    expect(transition.event).toMatchObject({ persisted: true, durable: true });
    expect(transition.state).toMatchObject({ persisted: false, kind: 'failed' });
    expect(transition.state?.error).toContain('injected state snapshot failure');

    const replay = await store.readView(claimed.claim);
    expect(replay).toMatchObject({ sequence: 2, state: 'running', reason: { step: 1 } });
    expect(holder.fs).toBe(filesystem);
  });

  it('keeps committed-but-not-durable outcome evidence explicit', async () => {
    tempDir = await createTrackedTempDir('chestnut-exec-store-durability-');
    const filesystem = new InjectingFileSystem(tempDir, async (recordPath, write) => {
      const result = await write();
      if (recordPath.includes('.outcome.json.staging-')) {
        return { kind: 'committed_platform_limited', error: Object.assign(new Error('directory fsync unsupported'), { code: 'ENOTSUP' }) };
      }
      return result;
    });
    const store = createSubagentExecutionStore({ fs: filesystem, resultDir: 'results/run' });
    const location = { runId: 'run-a', resultDir: 'results/run' };
    const input = await store.prepareInput(location, { prompt: 'x' });
    const claimed = await store.claimAttempt({ location, inputDigest: input.document.inputDigest, ordinal: 1, parentAttemptId: null, startBasis: 'start' });
    if (claimed.kind !== 'claimed') throw new Error('expected claim');
    await claimed.writer.transition({ state: 'prepared' });

    const final = await claimed.writer.settle({ kind: 'completed', content: 'real result', rawResult: { ok: true } });
    expect(final.persistence.outcome).toMatchObject({
      kind: 'committed_platform_limited', persisted: true, durable: false,
    });
    expect(final.persistence.outcome.error).toContain('directory fsync unsupported');
    expect((await store.readView(claimed.claim)).outcome?.content).toBe('real result');
  });

  it('returns recovery_required with original evidence when outcome publication fails', async () => {
    tempDir = await createTrackedTempDir('chestnut-exec-store-outcome-failure-');
    const filesystem = new InjectingFileSystem(tempDir, async (recordPath, write) => {
      if (recordPath.includes('.outcome.json.staging-')) throw new Error('injected read-only outcome directory');
      return write();
    });
    const store = createSubagentExecutionStore({ fs: filesystem, resultDir: 'results/run' });
    const location = { runId: 'run-a', resultDir: 'results/run' };
    const input = await store.prepareInput(location, { prompt: 'x' });
    const claimed = await store.claimAttempt({ location, inputDigest: input.document.inputDigest, ordinal: 1, parentAttemptId: null, startBasis: 'start' });
    if (claimed.kind !== 'claimed') throw new Error('expected claim');
    await claimed.writer.transition({ state: 'prepared' });

    const final = await claimed.writer.settle({ kind: 'completed', content: 'not falsely durable' });
    expect(final.kind).toBe('completed');
    expect(final.persistence.outcome).toMatchObject({ persisted: false, durable: false, kind: 'failed' });
    expect(final.persistence.outcome.error).toContain('injected read-only outcome directory');
    expect(final.degraded).toContainEqual(expect.objectContaining({ stage: 'outcome' }));
    expect(claimed.writer.view.state).toBe('recovery_required');
    const read = await store.readView(claimed.claim);
    expect(read.state).toBe('recovery_required');
    expect(read.outcome).toBeUndefined();
    await expect(store.readView({ ...claimed.claim, attemptId: 'missing' })).rejects.toBeInstanceOf(SubagentExecutionStoreError);
  });
});
