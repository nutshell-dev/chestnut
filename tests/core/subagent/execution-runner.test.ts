import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { NodeFileSystem, type AtomicWriteResult } from '../../../src/foundation/fs/index.js';
import {
  createSubagentExecutionRunner,
  type SubagentExecutionDriver,
} from '../../../src/core/subagent/execution-runner.js';
import { RecoveryUncertainSideEffectError } from '../../../src/core/subagent/recovery-state.js';
import type { SubagentExecutionView } from '../../../src/core/subagent/execution-types.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

class StopFailureFs extends NodeFileSystem {
  override async writeAtomic(recordPath: string, content: string): Promise<AtomicWriteResult> {
    if (recordPath.includes('/stops/.')) throw new Error('injected stop intent EIO');
    return super.writeAtomic(recordPath, content);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Phase 2248 Step D self-owned execution runner', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
    tempDir = undefined;
  });

  async function setup(tag: string) {
    tempDir = await createTrackedTempDir(`chestnut-execution-runner-${tag}-`);
    const fs = new NodeFileSystem({ baseDir: tempDir });
    return { fs, runId: 'run-a', resultDir: 'results/run', input: { prompt: 'persisted input' } };
  }

  it('returns after admission, then orders real result, outcome, close and completion', async () => {
    const { fs, runId, resultDir, input } = await setup('normal');
    const created = deferred<Parameters<SubagentExecutionDriver['createAttempt']>[0]>();
    const release = deferred();
    const order: string[] = [];
    const driver: SubagentExecutionDriver = {
      createAttempt(request) {
        created.resolve(request);
        return {
          completion: (async () => {
            order.push('run');
            await release.promise;
            order.push('final_save_and_cursor');
            return { content: 'done', rawResult: { text: 'done' } };
          })(),
          close: () => {
            const outcomePath = fs.resolve(path.join(resultDir, 'execution/attempts/1/outcome.json'));
            order.push(`writer_close_outcome:${existsSync(outcomePath)}`);
          },
        };
      },
    };
    const runner = createSubagentExecutionRunner({ fs, driver });
    const ref = await runner.start({ runId, resultDir, input, deadlineAtMs: 10_000 }); // time-fixture: bounded absolute-deadline input
    const request = await created.promise;
    expect(request.input).toEqual(input);
    expect(request.deadlineAtMs).toBe(10_000);
    const completion = ref.completion.then(outcome => { order.push('completion'); return outcome; });
    expect(order).toEqual(['run']);
    expect(JSON.parse(await fs.read(path.join(resultDir, 'execution/input.json'))).input).toEqual(input);
    expect(JSON.parse(await fs.read(path.join(resultDir, 'execution/attempts/1/claim.json')))).toMatchObject({
      deadlineAtMs: 10_000, // time-fixture: bounded persisted-deadline assertion
      startBasis: { kind: 'start' },
    });

    release.resolve();
    const outcome = await completion;
    expect(outcome).toMatchObject({ kind: 'completed', content: 'done', recovery: 'none' });
    expect(order).toEqual(['run', 'final_save_and_cursor', 'writer_close_outcome:true', 'completion']);
    expect(JSON.parse(await fs.read(path.join(resultDir, 'execution/attempts/1/outcome.json')))).toMatchObject({
      kind: 'completed',
      content: 'done',
      rawResult: { text: 'done' },
    });
  });

  it('duplicate start and open join without executing; stop signals but never settles a gated loop', async () => {
    const { fs, runId, resultDir, input } = await setup('stop');
    const created = deferred<Parameters<SubagentExecutionDriver['createAttempt']>[0]>();
    const release = deferred();
    const createAttempt = vi.fn<SubagentExecutionDriver['createAttempt']>(request => {
      created.resolve(request);
      return {
        completion: (async () => {
          await release.promise;
          return { content: 'late success', rawResult: { text: 'late success' } };
        })(),
        close: vi.fn(),
      };
    });
    const runner = createSubagentExecutionRunner({ fs, driver: { createAttempt } });
    const ref = await runner.start({ runId, resultDir, input });
    const request = await created.promise;
    const duplicate = await createSubagentExecutionRunner({ fs, driver: { createAttempt } }).start({ runId, resultDir, input });
    expect(duplicate).toBe(ref);
    expect((await runner.open({ runId, resultDir })).kind).toBe('found');
    expect(createAttempt).toHaveBeenCalledTimes(1);
    await expect(runner.start({ runId, resultDir, input: { prompt: 'different' } })).rejects.toMatchObject({ kind: 'conflict' });

    const completed = vi.fn();
    void ref.completion.then(completed);
    const reason = { type: 'user', detail: 'caller stopped waiting' };
    const receipt = await ref.requestStop(reason);
    expect(receipt).toMatchObject({ accepted: true, state: 'stopping', persisted: true });
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toEqual(reason);
    expect(completed).not.toHaveBeenCalled();
    expect(await fs.exists(path.join(resultDir, 'execution/attempts/1/outcome.json'))).toBe(false);

    release.resolve();
    const outcome = await ref.completion;
    expect(completed).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: 'interrupted',
      content: 'late success',
      rawResult: { text: 'late success' },
      recovery: 'none',
      cause: { name: 'AbortError', abortReason: reason },
    });
  });

  it('keeps the original parent signal attached after start returns until actual convergence', async () => {
    const { fs, runId, resultDir, input } = await setup('parent');
    const created = deferred<Parameters<SubagentExecutionDriver['createAttempt']>[0]>();
    const release = deferred();
    const runner = createSubagentExecutionRunner({
      fs,
      driver: {
        createAttempt(request) {
          created.resolve(request);
          return {
            completion: release.promise.then(() => ({ content: 'parent late result' })),
            close: () => {},
          };
        },
      },
    });
    const parent = new AbortController();
    const ref = await runner.start({ runId, resultDir, input, signal: parent.signal });
    const request = await created.promise;
    const completed = vi.fn();
    void ref.completion.then(completed);

    parent.abort({ type: 'external', source: 'parent' });
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toEqual({ type: 'external', source: 'parent' });
    expect(completed).not.toHaveBeenCalled();

    release.resolve();
    expect(await ref.completion).toMatchObject({ kind: 'interrupted', content: 'parent late result' });
    expect(completed).toHaveBeenCalledOnce();
  });

  it('stop intent write failure is explicit but still signals without a pseudo-terminal outcome', async () => {
    tempDir = await createTrackedTempDir('chestnut-execution-runner-stop-failure-');
    const fs = new StopFailureFs({ baseDir: tempDir });
    const created = deferred<Parameters<SubagentExecutionDriver['createAttempt']>[0]>();
    const release = deferred();
    const runner = createSubagentExecutionRunner({
      fs,
      driver: {
        createAttempt(request) {
          created.resolve(request);
          return {
            completion: release.promise.then(() => ({ content: 'stopped after real release' })),
            close: () => {},
          };
        },
      },
    });
    const ref = await runner.start({ runId: 'run-a', resultDir: 'results/run', input: { prompt: 'stop' } });
    const request = await created.promise;
    const completed = vi.fn();
    void ref.completion.then(completed);
    const receipt = await ref.requestStop({ type: 'user' });
    expect(receipt).toMatchObject({ accepted: true, persisted: false, durable: false });
    expect(receipt.persistence.error).toContain('injected stop intent EIO');
    expect(request.signal.aborted).toBe(true);
    expect(completed).not.toHaveBeenCalled();

    release.resolve();
    await expect(ref.completion).resolves.toMatchObject({ kind: 'interrupted', content: 'stopped after real release' });
  });

  it('normalizes failure without dropping the original cause or shared dependency fact', async () => {
    const { fs, runId, resultDir, input } = await setup('failure');
    const original = new Error('all shared providers failed');
    const runner = createSubagentExecutionRunner({
      fs,
      driver: {
        createAttempt: () => ({
          completion: Promise.reject(original),
          close: () => {},
        }),
        recoveryFor: error => error === original ? 'shared_dependency' : 'none',
      },
    });
    const ref = await runner.start({ runId, resultDir, input });
    const outcome = await ref.completion;
    expect(outcome.kind).toBe('failed');
    expect(outcome.cause).toBe(original);
    expect(outcome.recovery).toBe('shared_dependency');
    expect(outcome.content).toContain('all shared providers failed');
  });

  it('resume is explicit, preserves the absolute deadline and keeps uncertain side effects typed', async () => {
    const { fs, runId, resultDir, input } = await setup('resume');
    const requests: Parameters<SubagentExecutionDriver['createAttempt']>[0][] = [];
    let executions = 0;
    let toolsExecuted = 0;
    const runner = createSubagentExecutionRunner({
      fs,
      driver: {
        createAttempt(request) {
          requests.push(request);
          executions += 1;
          return {
            completion: request.resume
              ? Promise.resolve({ content: 'recovered without replay', rawResult: { toolsExecuted } })
              : Promise.reject(new RecoveryUncertainSideEffectError('toolu_started')),
            close: () => {},
          };
        },
      },
    });
    const first = await runner.start({ runId, resultDir, input, deadlineAtMs: 50_000 }); // time-fixture: bounded absolute-deadline input
    const uncertain = await first.completion;
    expect(uncertain).toMatchObject({ kind: 'failed', recovery: 'uncertain_side_effect' });
    expect(uncertain.cause).toBeInstanceOf(RecoveryUncertainSideEffectError);

    const opened = await runner.open({ runId, resultDir, attemptId: first.identity.attemptId });
    expect(opened.kind).toBe('found');
    expect(executions).toBe(1);
    const resumed = await runner.resume({
      runId,
      resultDir,
      input,
      previousAttemptId: first.identity.attemptId,
      deadlineAtMs: 999_999, // time-fixture: ignored replacement deadline input
    });
    const recovered = await resumed.completion;
    expect(recovered).toMatchObject({ kind: 'completed', content: 'recovered without replay' });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ resume: true, deadlineAtMs: 50_000 }); // time-fixture: bounded inherited-deadline assertion
    expect(toolsExecuted).toBe(0);
    expect(JSON.parse(await fs.read(path.join(resultDir, 'execution/attempts/2/claim.json')))).toMatchObject({
      parentAttemptId: first.identity.attemptId,
      deadlineAtMs: 50_000, // time-fixture: bounded persisted-deadline assertion
      startBasis: { kind: 'resume', previousAttemptId: first.identity.attemptId },
    });
  });

  it('passes dynamic run identity and absolute deadlines to a shared driver', async () => {
    const { fs, input } = await setup('dynamic-identity');
    const requests: Parameters<SubagentExecutionDriver['createAttempt']>[0][] = [];
    const runner = createSubagentExecutionRunner({
      fs,
      driver: {
        createAttempt(request) {
          requests.push(request);
          return { completion: Promise.resolve({ content: request.runId }), close: () => {} };
        },
      },
    });

    const first = await runner.start({ runId: 'task-a', resultDir: 'results/a', input, deadlineAtMs: 11_000 }); // time-fixture: bounded absolute-deadline input
    const second = await runner.start({ runId: 'task-b', resultDir: 'results/b', input, deadlineAtMs: 22_000 }); // time-fixture: bounded absolute-deadline input
    await expect(first.completion).resolves.toMatchObject({ content: 'task-a' });
    await expect(second.completion).resolves.toMatchObject({ content: 'task-b' });
    expect(requests.map(request => ({
      runId: request.runId,
      resultDir: request.resultDir,
      deadlineAtMs: request.deadlineAtMs,
    }))).toEqual([
      { runId: 'task-a', resultDir: 'results/a', deadlineAtMs: 11_000 }, // time-fixture: bounded deadline-forwarding assertion
      { runId: 'task-b', resultDir: 'results/b', deadlineAtMs: 22_000 }, // time-fixture: bounded deadline-forwarding assertion
    ]);
  });

  it('open joins subsequent active-owner events without acquiring control or starting execution', async () => {
    const { fs, runId, resultDir, input } = await setup('open-active-owner');
    const release = deferred();
    const createAttempt = vi.fn<SubagentExecutionDriver['createAttempt']>(() => ({
      completion: release.promise.then(() => ({ content: 'active owner finished' })),
      close: () => {},
    }));
    const runner = createSubagentExecutionRunner({ fs, driver: { createAttempt } });
    const owner = await runner.start({ runId, resultDir, input });
    await vi.waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(1));
    const opened = await runner.open({ runId, resultDir });
    expect(opened.kind).toBe('found');
    if (opened.kind !== 'found') return;
    expect(opened.ref).not.toHaveProperty('requestStop');
    expect(createAttempt).toHaveBeenCalledTimes(1);

    const observed = deferred<SubagentExecutionView>();
    opened.ref.observe(view => { if (view.outcome) observed.resolve(view); });
    release.resolve();
    await expect(owner.completion).resolves.toMatchObject({ kind: 'completed' });
    await expect(observed.promise).resolves.toMatchObject({
      state: 'settled',
      outcome: { kind: 'completed', content: 'active owner finished' },
    });
    expect(createAttempt).toHaveBeenCalledTimes(1);
  });

  it('releases completion with recovery_required evidence when outcome publication fails', async () => {
    const { fs, runId, resultDir, input } = await setup('outcome-failure');
    const originalWrite = fs.writeAtomic.bind(fs);
    let outcomeFailures = 0;
    vi.spyOn(fs, 'writeAtomic').mockImplementation(async (recordPath, content) => {
      if (recordPath.includes('/.outcome.json.staging-') && outcomeFailures++ === 0) {
        throw new Error('injected outcome EIO');
      }
      return originalWrite(recordPath, content);
    });
    const runner = createSubagentExecutionRunner({
      fs,
      driver: {
        createAttempt: () => ({ completion: Promise.resolve({ content: 'actual success' }), close: () => {} }),
      },
    });
    const ref = await runner.start({ runId, resultDir, input });
    const outcome = await ref.completion;
    expect(outcome.kind).toBe('completed');
    expect(outcome.persistence.outcome).toMatchObject({ persisted: false, durable: false });
    expect(outcome.persistence.outcome.error).toContain('injected outcome EIO');
    expect((await ref.read()).state).toBe('recovery_required');

    // The process is alive but the real attempt is settled; only this physical
    // convergence evidence permits a successor despite the failed outcome write.
    const successor = await runner.resume({
      runId,
      resultDir,
      input,
      previousAttemptId: ref.identity.attemptId,
    });
    await expect(successor.completion).resolves.toMatchObject({ kind: 'completed', content: 'actual success' });
    expect(await fs.exists(path.join(resultDir, 'execution/attempts/2/outcome.json'))).toBe(true);
  });
});
