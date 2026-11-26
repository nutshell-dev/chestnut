import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { consumeTaskExecution, EXECUTION_LINK_FILE } from '../../../src/core/async-task-system/execution-consumer.js';
import { createExecutionInputStore } from '../../../src/core/async-task-system/execution-input-store.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { LLM_WAIT_FILE } from '../../../src/core/async-task-system/llm-wait-state.js';
import { recoverTasks } from '../../../src/core/async-task-system/task-recovery.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import {
  makeFullTaskId,
  makeShortTaskId,
  type SubAgentTask,
  type TaskExecutionIdentity,
  type TaskExecutionPort,
  type TaskExecutionRef,
  type TaskExecutionView,
  type TaskSourceOutcome,
} from '../../../src/core/async-task-system/types.js';
import type { SubagentRunner } from '../../../src/core/subagent/index.js';
import { createMockWatcherFactory } from '../../helpers/task-system.js';
import { createTempDir } from '../../utils/temp.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function audit(): AuditLog {
  return { write: vi.fn(), preview: String, message: String, summary: String };
}

async function fixture() {
  const root = await createTempDir('ats-execution-reference-');
  roots.push(root);
  return { root, fs: new NodeFileSystem({ baseDir: root }) };
}

function task(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  const id = randomUUID();
  return {
    kind: 'subagent', id: makeFullTaskId(id), shortId: makeShortTaskId(id.slice(0, 8)),
    intent: 'run reference test', timeoutMs: 60_000, maxSteps: 2,
    parentClawId: 'parent', createdAt: '2026-01-01T00:00:00.000Z',
    executionInput: { schema_version: 1, input: { schema_version: 1, kind: 'test-input' } },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function reference(identity: TaskExecutionIdentity, completion: Promise<TaskSourceOutcome>) {
  let view: TaskExecutionView = { identity, sequence: 0, state: 'running' };
  const listeners = new Set<(view: TaskExecutionView) => void>();
  void completion.then(outcome => {
    view = { identity, sequence: 1, state: 'settled', outcome };
    for (const listener of listeners) listener(view);
  });
  const ref: TaskExecutionRef = {
    identity, completion,
    read: async () => view,
    observe: listener => { listeners.add(listener); listener(view); return () => { listeners.delete(listener); }; },
    requestStop: vi.fn(async reason => ({ accepted: true, state: 'stopping', persisted: true, durable: true, reason })),
  };
  return ref;
}

function outcome(identity: TaskExecutionIdentity, kind: TaskSourceOutcome['kind'] = 'completed'): TaskSourceOutcome {
  return { identity, kind, content: kind === 'completed' ? 'ok' : kind, recovery: 'none' };
}

async function scheduleExisting(system: AsyncTaskSystem, item: SubAgentTask): Promise<void> {
  const { id, shortId: _shortId, createdAt, ...payload } = item;
  await system.schedulePrepared('subagent', { id: makeFullTaskId(id), createdAt, payload });
}

// Compile-time structural handoff: SubAgent never imports this ATS port.
const asTaskExecutionPort = (runner: SubagentRunner): TaskExecutionPort => runner;

describe('Phase 2248 F execution references', () => {
  it('SubagentRunner is structurally assignable to the ATS port', () => {
    expect(asTaskExecutionPort).toBeTypeOf('function');
  });

  it('cancel receipt timeout retains the physical slot and only true completion delivers once', async () => {
    vi.useFakeTimers();
    const { root, fs } = await fixture();
    const item = task();
    const identity = { runId: item.id, attemptId: 'attempt-1', resultDir: `tasks/queues/results/${item.id}` };
    const pending = deferred<TaskSourceOutcome>();
    const ref = reference(identity, pending.promise);
    const execution: TaskExecutionPort = {
      start: vi.fn(async () => ref),
      open: vi.fn(), resume: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ kind: 'delivered' as const }));
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs, execution, deliverySink: { deliver },
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    await system.initialize();
    await scheduleExisting(system, item);
    await system.startDispatch();
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(1));

    const cancelling = system.cancelDetailed(item.id);
    await vi.advanceTimersByTimeAsync(5_000);
    const cancelled = await cancelling;
    expect(cancelled).toMatchObject({ kind: 'running_cancelled', settle: { kind: 'timeout' }, terminal: 'not_observed' });
    expect(system.getInProcessRunningCount()).toBe(1);
    expect(ref.requestStop).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(await fs.exists(`tasks/queues/failed/${item.id}.json`)).toBe(false);

    pending.resolve(outcome(identity, 'interrupted'));
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await fs.exists(`tasks/queues/failed/${item.id}.json`)).toBe(true);
    await system.shutdown(1);
  });

  it('bounded shutdown reports and retains an unconverged reference', async () => {
    vi.useFakeTimers();
    const { root, fs } = await fixture();
    const item = task();
    const identity = { runId: item.id, attemptId: 'attempt-shutdown', resultDir: `tasks/queues/results/${item.id}` };
    const pending = deferred<TaskSourceOutcome>();
    const ref = reference(identity, pending.promise);
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs,
      execution: { start: vi.fn(async () => ref), open: vi.fn(), resume: vi.fn() },
      deliverySink: { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) },
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    await system.initialize();
    await scheduleExisting(system, item);
    await system.startDispatch();
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(1));

    const shuttingDown = system.shutdown(10);
    await vi.advanceTimersByTimeAsync(1_010);
    expect(await shuttingDown).toEqual({ kind: 'timed_out', pending: [item.id], terminal: [] });
    expect(system.getInProcessRunningCount()).toBe(1);
    pending.resolve(outcome(identity, 'interrupted'));
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
  });

  it('a genuinely settled shared-dependency failure persists waiting and releases its physical slot', async () => {
    const { root, fs } = await fixture();
    const item = task();
    const identity = { runId: item.id, attemptId: 'waiting-attempt', resultDir: `tasks/queues/results/${item.id}` };
    const final: TaskSourceOutcome = { identity, kind: 'failed', content: 'shared unavailable', recovery: 'shared_dependency' };
    const deliver = vi.fn();
    const sharedRecovery = { getSharedRecoveryDecision: vi.fn(() => ({ kind: 'on_change' as const })) };
    const start = vi.fn(async () => reference(identity, Promise.resolve(final)));
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs, sharedRecovery,
      execution: { start, open: vi.fn(), resume: vi.fn() },
      deliverySink: { deliver }, createWatcher: createMockWatcherFactory(fs).factory,
    });
    await system.initialize();
    await scheduleExisting(system, item);
    await system.startDispatch();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
    expect(sharedRecovery.getSharedRecoveryDecision).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    const wait = JSON.parse(await fs.read(`tasks/queues/results/${item.id}/${LLM_WAIT_FILE}`)) as Record<string, unknown>;
    expect(wait.execution).toEqual(identity);
    expect(await fs.exists(`tasks/queues/running/${item.id}.json`)).toBe(true);
    expect(await fs.exists(`tasks/queues/failed/${item.id}.json`)).toBe(false);
    await system.shutdown(1);
  });

  it('start/link failure reopens the deterministic attempt instead of starting twice', async () => {
    const { fs } = await fixture();
    const item = task();
    const runningPath = `tasks/queues/running/${item.id}.json`;
    await fs.writeAtomic(runningPath, JSON.stringify(item));
    const identity = { runId: item.id, attemptId: 'crash-attempt', resultDir: `tasks/queues/results/${item.id}` };
    const final = outcome(identity);
    const ref = reference(identity, Promise.resolve(final));
    let failLink = true;
    const originalWrite = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path, content) => {
      if (failLink && path.endsWith(EXECUTION_LINK_FILE)) {
        failLink = false;
        throw new Error('crash after start before link');
      }
      return originalWrite(path, content);
    };
    const execution: TaskExecutionPort = {
      start: vi.fn(async () => ref),
      open: vi.fn(async () => ({
        kind: 'found' as const, runId: item.id, resultDir: identity.resultDir,
        identity, view: { identity, sequence: 1, state: 'settled' as const, outcome: final },
        ref, owner: 'settled' as const,
      })),
      resume: vi.fn(),
    };
    const result = await consumeTaskExecution(item, new AbortController().signal, {
      fs, execution, inputStore: createExecutionInputStore(fs),
    });
    expect(result).toMatchObject({ content: 'ok', sourceIsError: false });
    expect(execution.start).toHaveBeenCalledTimes(1);
    expect(execution.open).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.read(`tasks/queues/results/${item.id}/${EXECUTION_LINK_FILE}`))).toMatchObject(identity);
  });

  it('waiting recovery uses explicit resume and preserves the original absolute budget', async () => {
    const { fs } = await fixture();
    const item = task();
    await fs.writeAtomic(`tasks/queues/running/${item.id}.json`, JSON.stringify(item));
    const previous = { runId: item.id, attemptId: 'old-attempt', resultDir: `tasks/queues/results/${item.id}` };
    await fs.writeAtomic(`tasks/queues/results/${item.id}/${EXECUTION_LINK_FILE}`, JSON.stringify({ schema_version: 1, ...previous }));
    await fs.writeAtomic(`tasks/queues/results/${item.id}/${LLM_WAIT_FILE}`, JSON.stringify({
      schema_version: 1, orchestrator_instance: 'claw-process', nextProbeAt: 10, recordedAt: 5,
      expiresAt: 1000, reason: 'shared', execution: previous,
      resumeIntent: { target: 'pending', decidedAt: 10 },
    }));
    const next = { ...previous, attemptId: 'new-attempt' };
    const ref = reference(next, Promise.resolve(outcome(next)));
    const execution: TaskExecutionPort = { start: vi.fn(), open: vi.fn(), resume: vi.fn(async () => ref) };
    const result = await consumeTaskExecution(item, new AbortController().signal, {
      fs, execution, inputStore: createExecutionInputStore(fs),
    });
    expect(result.sourceIsError).toBe(false);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.resume).toHaveBeenCalledWith(expect.objectContaining({
      previousAttemptId: 'old-attempt', deadlineAtMs: Date.parse(item.createdAt) + item.timeoutMs,
    }));
    expect(JSON.parse(await fs.read(`tasks/queues/results/${item.id}/${EXECUTION_LINK_FILE}`))).toMatchObject(next);
    expect(await fs.exists(`tasks/queues/results/${item.id}/${LLM_WAIT_FILE}`)).toBe(false);
  });

  it('only shared_dependency invokes the ATS-injected decision; interrupted never waits', async () => {
    const { fs } = await fixture();
    const item = task();
    await fs.writeAtomic(`tasks/queues/running/${item.id}.json`, JSON.stringify(item));
    const identity = { runId: item.id, attemptId: 'interrupted', resultDir: `tasks/queues/results/${item.id}` };
    const final: TaskSourceOutcome = { identity, kind: 'interrupted', content: 'timeout', recovery: 'shared_dependency' };
    const sharedRecovery = { getSharedRecoveryDecision: vi.fn(() => ({ kind: 'at' as const, nextProbeAt: 123 })) };
    const result = await consumeTaskExecution(item, new AbortController().signal, {
      fs,
      execution: { start: async () => reference(identity, Promise.resolve(final)), open: vi.fn(), resume: vi.fn() },
      inputStore: createExecutionInputStore(fs), sharedRecovery,
    });
    expect(result.waiting).toBeUndefined();
    expect(result.sourceIsError).toBe(true);
    expect(sharedRecovery.getSharedRecoveryDecision).not.toHaveBeenCalled();
  });

  it('startup persists the open identity so later consumption never restarts a crashed start/link window', async () => {
    const { fs } = await fixture();
    const item = task();
    await fs.writeAtomic(`tasks/queues/running/${item.id}.json`, JSON.stringify(item));
    await fs.ensureDir('tasks/queues/pending');
    await fs.ensureDir('tasks/queues/failed');
    const identity = { runId: item.id, attemptId: 'restart-attempt', resultDir: `tasks/queues/results/${item.id}` };
    const final = outcome(identity);
    const ref = reference(identity, Promise.resolve(final));
    const execution: TaskExecutionPort = {
      start: vi.fn(), resume: vi.fn(),
      open: vi.fn(async () => ({
        kind: 'found' as const, runId: item.id, resultDir: identity.resultDir, identity,
        view: { identity, sequence: 1, state: 'settled' as const, outcome: final }, ref, owner: 'settled' as const,
      })),
    };
    await recoverTasks({ fs, auditWriter: audit(), execution });
    expect(await fs.exists(`tasks/queues/pending/${item.id}.json`)).toBe(true);
    expect(JSON.parse(await fs.read(`tasks/queues/results/${item.id}/${EXECUTION_LINK_FILE}`))).toMatchObject(identity);
    const consumed = await consumeTaskExecution(item, new AbortController().signal, {
      fs, execution, inputStore: createExecutionInputStore(fs),
    });
    expect(consumed.sourceIsError).toBe(false);
    expect(execution.open).toHaveBeenCalledTimes(2);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
  });

  it('startup holds uncertain side effects without start or automatic resume', async () => {
    const { fs } = await fixture();
    const item = task();
    await fs.writeAtomic(`tasks/queues/running/${item.id}.json`, JSON.stringify(item));
    await fs.ensureDir('tasks/queues/pending');
    await fs.ensureDir('tasks/queues/failed');
    const identity = { runId: item.id, attemptId: 'uncertain', resultDir: `tasks/queues/results/${item.id}` };
    const final: TaskSourceOutcome = { identity, kind: 'failed', content: 'tool outcome unknown', recovery: 'uncertain_side_effect' };
    const ref = reference(identity, Promise.resolve(final));
    const execution: TaskExecutionPort = {
      start: vi.fn(), resume: vi.fn(),
      open: vi.fn(async () => ({
        kind: 'found' as const, runId: item.id, resultDir: identity.resultDir, identity,
        view: { identity, sequence: 1, state: 'settled' as const, outcome: final }, ref, owner: 'settled' as const,
      })),
    };
    await recoverTasks({ fs, auditWriter: audit(), execution });
    expect(execution.open).toHaveBeenCalledTimes(1);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
    expect(await fs.exists(`tasks/queues/running/${item.id}.json`)).toBe(true);
    expect(await fs.exists(`tasks/queues/pending/${item.id}.json`)).toBe(false);
  });
});


describe('Phase 2248 F shared recovery projection', () => {
  it('ATS alone queries the owner and preserves the settled attempt identity in waiting', async () => {
    const { fs } = await fixture();
    const item = task();
    await fs.writeAtomic(`tasks/queues/running/${item.id}.json`, JSON.stringify(item));
    const identity = { runId: item.id, attemptId: 'shared-attempt', resultDir: `tasks/queues/results/${item.id}` };
    const final: TaskSourceOutcome = {
      identity, kind: 'failed', content: 'all providers unavailable', recovery: 'shared_dependency', cause: new Error('all providers unavailable'),
    };
    const sharedRecovery = { getSharedRecoveryDecision: vi.fn(() => ({ kind: 'at' as const, nextProbeAt: Date.now() + 30_000 })) };
    const result = await consumeTaskExecution(item, new AbortController().signal, {
      fs,
      execution: { start: async () => reference(identity, Promise.resolve(final)), open: vi.fn(), resume: vi.fn() },
      inputStore: createExecutionInputStore(fs), sharedRecovery,
    });
    expect(sharedRecovery.getSharedRecoveryDecision).toHaveBeenCalledTimes(1);
    expect(result.waiting).toMatchObject({ execution: identity, reason: final.content });
    expect(result.uncertain).toBeUndefined();
  });
});
