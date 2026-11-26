import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { TOOL_EXEC_CLEANUP_BUDGET_MS } from '../../../src/foundation/tools/constants.js';
import type { ExecContext, Tool } from '../../../src/foundation/tools/types.js';
import { makeExecContext } from '../../helpers/exec-context.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tool(name: string, execute: Tool['execute'], outputBounds?: Tool['outputBounds']): Tool {
  return {
    name,
    description: `${name} fixture`,
    schema: { type: 'object', properties: { value: { type: 'string' } } },
    readonly: true,
    idempotent: true,
    profiles: ['full'],
    ...(outputBounds ? { outputBounds } : {}),
    execute,
  };
}

function memoryContext() {
  const records = new Map<string, string>();
  const writeAtomic = vi.fn(async (path: string, content: string) => {
    records.set(path, content);
    return { kind: 'durable' } as const;
  });
  const ctx = makeExecContext({ fs: { writeAtomic } as unknown as FileSystem });
  return { ctx, records, writeAtomic };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Tools real execution settlement', () => {
  it('keeps completion pending through cleanup timeout, then retains the complete late result and timeout cause', async () => {
    vi.useFakeTimers();
    const gate = deferred<ToolResult>();
    const raw = `late-body-${'🙂'.repeat(400)}`;
    const registry = new ToolRegistryImpl();
    registry.register(tool('noncooperative', () => gate.promise, {
      maxBytes: 512,
      maxLines: 8,
      artifactKind: 'late',
    }));
    const { ctx, records } = memoryContext();
    const executor = new ToolExecutorImpl(registry, 60_000);

    const ref = await executor.begin({ toolName: 'noncooperative', args: {}, ctx, timeoutMs: 20 }); // time-fixture: bounded tool timeout for late-settlement timing
    const views: string[] = [];
    ref.observe((view) => views.push(`${view.seq}:${view.state}:${view.cleanup ?? '-'}`));
    let completed = false;
    void ref.completion.then(() => { completed = true; });

    await vi.advanceTimersByTimeAsync(20 + TOOL_EXEC_CLEANUP_BUDGET_MS);
    expect(completed).toBe(false);
    expect(views).toContain('1:stopping:-');
    expect(views.at(-1)).toBe('2:stopping:pending');

    gate.resolve({ success: true, content: raw });
    const final = await ref.completion;
    expect(completed).toBe(true);
    expect(final.actualResult?.content).toBe(raw);
    expect(final.boundedActualResult?.content).toContain('full output saved at');
    expect(final.boundedActualResult?.content).not.toBe(raw);
    expect(final.presentedResult.success).toBe(false);
    expect(final.presentedResult.content).toContain('execution limit');
    expect(final.presentation).toEqual({ kind: 'timeout', reason: { type: 'tool_timeout', ms: 20 } });
    expect(final.stopReason).toEqual({ type: 'tool_timeout', ms: 20 });
    expect(final.persistence.final).toMatchObject({ kind: 'durable', persisted: true, durable: true });

    const journal = JSON.parse(records.get(final.persistence.final.path)!);
    expect(journal.actualResult.content).toBe(raw);
    expect(journal.boundedActualResult.metadata.output.artifact.path).toBe(
      final.boundedActualResult?.metadata?.output?.artifact?.path,
    );
    expect(journal.presentedResult.content).toContain('execution limit');
    expect(journal.presentedResult).not.toBe('[Circular]');
    expect(records.has(`${final.persistence.journalPath}/started.json`)).toBe(true);
  });

  it('keeps the legacy execute projection pending until a noncooperative handler really settles', async () => {
    vi.useFakeTimers();
    const gate = deferred<ToolResult>();
    const handlerStarted = deferred<void>();
    const registry = new ToolRegistryImpl();
    registry.register(tool('legacy-projection', () => {
      handlerStarted.resolve();
      return gate.promise;
    }));
    const { ctx } = memoryContext();
    const pending = new ToolExecutorImpl(registry).execute({
      toolName: 'legacy-projection', args: {}, ctx, timeoutMs: 10, // time-fixture: bounded tool timeout for pending-projection timing
    });
    let completed = false;
    void pending.then(() => { completed = true; });
    await handlerStarted.promise;

    await vi.advanceTimersByTimeAsync(10 + TOOL_EXEC_CLEANUP_BUDGET_MS);
    expect(completed).toBe(false);

    gate.resolve({ success: true, content: 'late execute body' });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit');
    expect(completed).toBe(true);
  });

  it('uses the caller output domain for journals and late/full-output artifacts during a cross-claw read', async () => {
    const caller = memoryContext();
    const targetWrite = vi.fn(async () => ({ kind: 'durable' }) as const);
    const raw = 'caller-owned-output-'.repeat(100);
    const registry = new ToolRegistryImpl();
    registry.register(tool('cross-read', async () => ({ success: true, content: raw }), {
      maxBytes: 256,
      maxLines: 4,
      artifactKind: 'cross',
    }));
    caller.ctx.clawDir = '/target';
    caller.ctx.fs = { writeAtomic: targetWrite } as unknown as FileSystem;
    caller.ctx.toolOutput = {
      fs: { writeAtomic: caller.writeAtomic },
      baseDir: '/caller',
      syncDir: '/caller/tasks/sync',
      workspaceDir: '/caller/clawspace',
    };

    const final = await new ToolExecutorImpl(registry).begin({
      toolName: 'cross-read', args: {}, ctx: caller.ctx,
    }).then((ref) => ref.completion);

    expect(targetWrite).not.toHaveBeenCalled();
    expect([...caller.records.keys()].every((path) => path.startsWith('tasks/sync/'))).toBe(true);
    expect(final.persistence.journalPath).toContain('tasks/sync/tool-executions/');
    expect(final.boundedActualResult?.metadata?.output?.artifact).toMatchObject({ kind: 'durable' });
  });

  it('settles normal, admission-rejected, and thrown executions without confusing their causes', async () => {
    const registry = new ToolRegistryImpl();
    registry.register(tool('normal', async () => ({ success: true, content: 'ordinary body' })));
    registry.register(tool('throws', async () => {
      throw new Error('original boom', { cause: new Error('original root cause') });
    }));
    const { ctx } = memoryContext();
    const executor = new ToolExecutorImpl(registry, 1_000);

    const normal = await executor.begin({ toolName: 'normal', args: {}, ctx }).then((ref) => ref.completion);
    expect(normal).toMatchObject({
      outcome: 'completed',
      actualResult: { success: true, content: 'ordinary body' },
      presentedResult: { success: true, content: 'ordinary body' },
      presentation: { kind: 'actual' },
    });

    const rejected = await executor.begin({ toolName: 'normal', args: { value: 3 }, ctx }).then((ref) => ref.completion);
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.presentation).toEqual({ kind: 'rejected', reason: 'invalid_input' });
    expect(rejected.actualResult).toBeUndefined();

    const failed = await executor.begin({ toolName: 'throws', args: {}, ctx }).then((ref) => ref.completion);
    expect(failed.outcome).toBe('failed');
    expect(failed.actualError).toMatchObject({
      name: 'Error',
      message: 'original boom',
      cause: 'original root cause',
    });
    expect(failed.presentedResult.content).toContain('original boom');
    expect(failed.presentedResult.content).toContain('original root cause');
  });

  it('does not run a tool when the required started journal cannot be persisted', async () => {
    const execute = vi.fn(async () => ({ success: true, content: 'must not run' }));
    const registry = new ToolRegistryImpl();
    registry.register(tool('disk-blocked', execute));
    const diskError = new Error('injected read-only filesystem');
    const writeAtomic = vi.fn(async () => { throw diskError; });
    const ctx = makeExecContext({ fs: { writeAtomic } as unknown as FileSystem });

    const ref = await new ToolExecutorImpl(registry).begin({ toolName: 'disk-blocked', args: {}, ctx });
    const final = await ref.completion;

    expect(execute).not.toHaveBeenCalled();
    expect(final.outcome).toBe('rejected');
    expect(final.presentation.kind).toBe('journal_failed');
    expect(final.presentedResult).toMatchObject({
      success: false,
      error: 'tool_execution_journal_persist_failed',
    });
    expect(final.persistence.started).toMatchObject({ kind: 'failed', persisted: false });
    expect(final.persistence.started?.error).toContain('injected read-only filesystem');
    expect(final.persistence.final).toMatchObject({ kind: 'failed', persisted: false });
  });

  it('returns real output with typed evidence when only the final journal write fails', async () => {
    const registry = new ToolRegistryImpl();
    registry.register(tool('final-write-fails', async () => ({ success: true, content: 'real body' })));
    const writeAtomic = vi.fn(async (path: string, _content: string) => {
      if (path.endsWith('/final.json')) throw new Error('injected final write failure');
      return { kind: 'durable' } as const;
    });
    const ctx = makeExecContext({ fs: { writeAtomic } as unknown as FileSystem });

    const final = await new ToolExecutorImpl(registry).begin({
      toolName: 'final-write-fails', args: {}, ctx,
    }).then((ref) => ref.completion);

    expect(final.actualResult?.content).toBe('real body');
    expect(final.presentedResult).toEqual({ success: true, content: 'real body' });
    expect(final.persistence.final).toMatchObject({ kind: 'failed', persisted: false, durable: false });
    expect(final.persistence.final.error).toContain('injected final write failure');
  });

  it('returns a non-durable stop receipt without completing a noncooperative handler', async () => {
    const gate = deferred<ToolResult>();
    const registry = new ToolRegistryImpl();
    registry.register(tool('stop-evidence', () => gate.promise));
    const writeAtomic = vi.fn(async (path: string, _content: string) => {
      if (path.includes('/stop-')) throw new Error('injected stop journal failure');
      return { kind: 'durable' } as const;
    });
    const ctx = makeExecContext({ fs: { writeAtomic } as unknown as FileSystem });
    const ref = await new ToolExecutorImpl(registry, 60_000).begin({ toolName: 'stop-evidence', args: {}, ctx });
    let completed = false;
    void ref.completion.then(() => { completed = true; });

    const receipt = await ref.requestStop({ type: 'user_abort', cause: 'caller cancelled' });
    expect(receipt).toMatchObject({ accepted: true, state: 'stopping', persisted: false });
    expect(receipt.persistence?.error).toContain('injected stop journal failure');
    expect(completed).toBe(false);

    gate.resolve({ success: true, content: 'finished after stop' });
    const final = await ref.completion;
    expect(final.stopReason).toEqual({ type: 'user_abort', cause: 'caller cancelled' });
    expect(final.persistence.stops[0]).toMatchObject({ persisted: false, durable: false });
    expect(final.actualResult?.content).toBe('finished after stop');
  });

  it('retains an upstream abort cause separately from a later timeout presentation', async () => {
    vi.useFakeTimers();
    const gate = deferred<ToolResult>();
    const upstream = new AbortController();
    const registry = new ToolRegistryImpl();
    registry.register(tool('abort-then-timeout', () => gate.promise));
    const { ctx } = memoryContext();
    ctx.signal = upstream.signal;
    const ref = await new ToolExecutorImpl(registry).begin({
      toolName: 'abort-then-timeout', args: {}, ctx, timeoutMs: 50, // time-fixture: bounded tool timeout for abort-cause timing
    });
    const reason = { type: 'user_abort', message: 'stop this call' };

    upstream.abort(reason);
    await vi.advanceTimersByTimeAsync(50);
    gate.resolve({ success: true, content: 'eventual body' });
    const final = await ref.completion;

    expect(final.stopReason).toEqual(reason);
    expect(final.presentation).toEqual({ kind: 'timeout', reason: { type: 'tool_timeout', ms: 50 } });
    expect(final.actualResult?.content).toBe('eventual body');
    expect(final.presentedResult.content).toContain('execution limit');
  });
});
