import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import {
  createExecutionInputStore,
  EXECUTION_INPUT_FILE,
  ExecutionInputStoreError,
} from '../../../src/core/async-task-system/execution-input-store.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { SubAgentTaskSchema } from '../../../src/core/async-task-system/task-schemas.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { sha256Hex } from '../../../src/foundation/node-utils/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { createCanonicalToolManifestFromDefinitions } from '../../../src/foundation/tools/index.js';
import type { ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import {
  migrateShadowTaskInputs,
  type ShadowExecutorPayload,
} from '../../../src/core/shadow-system/index.js';
import {
  makeFullTaskId,
  makeShortTaskId,
  type PreparedSubagentSchedule,
  type SubAgentTask,
} from '../../../src/core/async-task-system/types.js';
import { createTempDir } from '../../utils/temp.js';
import {
  createMockWatcherFactory,
  makeTaskExecutionStub,
} from '../../helpers/task-system.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function audit(): AuditLog {
  return { write: vi.fn(), preview: String, message: String, summary: String };
}

async function fixture() {
  const root = await createTempDir('ats-execution-input-');
  roots.push(root);
  return { root, fs: new NodeFileSystem({ baseDir: root }) };
}

function prepared(executorPayload?: unknown): PreparedSubagentSchedule {
  const id = randomUUID();
  return {
    id: makeFullTaskId(id),
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: {
      kind: 'subagent', intent: 'legacy intent', timeoutMs: 30_000, maxSteps: 3,
      parentClawId: 'parent', systemPrompt: 'legacy system', toolProfile: 'subagent',
      ...(executorPayload !== undefined ? { executorPayload } : {}),
    },
  };
}

function legacySystem(root: string, fs: NodeFileSystem): AsyncTaskSystem {
  return new AsyncTaskSystem(root, fs, {
    auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
    fsFactory: () => fs,
    execution: { start: vi.fn(), open: vi.fn(), resume: vi.fn() },
    deliverySink: { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) },
  });
}

function taskFrom(preparation: PreparedSubagentSchedule): SubAgentTask {
  return {
    ...preparation.payload, id: preparation.id,
    shortId: makeShortTaskId(preparation.id.slice(0, 8)), createdAt: preparation.createdAt,
  };
}

const shadowTools: ToolDefinition[] = [{
  name: 'read',
  description: 'read',
  input_schema: { type: 'object', properties: {} },
}];
const shadowManifest = createCanonicalToolManifestFromDefinitions(shadowTools);

function legacyShadowPayload(): ShadowExecutorPayload {
  return {
    systemPrompt: 'frozen parent prompt',
    messages: [{ role: 'user', content: 'frozen Shadow instruction' }],
    toolsForLLM: shadowTools,
    manifestRevision: shadowManifest.revision,
    promptRevision: 'parent-prompt-revision',
    identity: { shadowId: 'shadow-running-legacy', originClawId: 'origin', isShadow: true },
    detached: true,
    budget: { timeoutMs: 30_000, maxSteps: 9, idleTimeoutMs: 500 },
  };
}

describe('Phase 2248 F execution input migration', () => {
  it('task schema accepts a strict versioned shell without removing legacy fields', () => {
    const item = taskFrom(prepared({ owner: 'shadow', nested: { keep: true } }));
    const withInput = { ...item, executionInput: { schema_version: 1, input: { owner_validated: true } } };
    const decoded = SubAgentTaskSchema.parse(withInput);
    expect(decoded.executorPayload).toEqual(item.executorPayload);
    expect(decoded.intent).toBe('legacy intent');
    expect(decoded.executionInput).toEqual(withInput.executionInput);
    expect(SubAgentTaskSchema.safeParse({ ...withInput, executionInput: { schema_version: 1 } }).success).toBe(false);
    expect(SubAgentTaskSchema.safeParse({ ...withInput, executionInput: { schema_version: 2, input: {} } }).success).toBe(false);
    expect(SubAgentTaskSchema.safeParse({ ...withInput, executionInput: { schema_version: 1, input: undefined } }).success).toBe(false);
  });

  it('sidecar commit preserves original task bytes, claim bytes and prepared replay', async () => {
    const { root, fs } = await fixture();
    const system = legacySystem(root, fs);
    const preparation = prepared();
    expect(await system.schedulePrepared('subagent', preparation)).toEqual({ taskId: preparation.id, disposition: 'created' });
    const taskPath = `tasks/queues/pending/${preparation.id}.json`;
    const claimPath = `tasks/queues/claims/${preparation.id}.json`;
    const taskBefore = await fs.read(taskPath);
    const claimBefore = await fs.read(claimPath);
    const store = createExecutionInputStore(fs);
    const [input] = await store.listUnpreparedInputs();
    expect(input).toMatchObject({
      kind: 'ordinary_legacy', taskId: preparation.id,
      declaration: { prompt: 'legacy intent', systemPrompt: 'legacy system', toolProfile: 'subagent' },
    });

    const committed = await store.commitPreparedInput({
      taskId: preparation.id, sourceHash: input.sourceHash,
      migrationSource: 'ordinary_legacy', input: { schema_version: 1, kind: 'prepared_subagent_input' },
    });
    expect(committed.sourceHash).toBe(input.sourceHash);
    expect(await fs.read(taskPath)).toBe(taskBefore);
    expect(await fs.read(claimPath)).toBe(claimBefore);
    expect(await system.schedulePrepared('subagent', preparation)).toEqual({ taskId: preparation.id, disposition: 'existing' });
    expect(await fs.read(taskPath)).toBe(taskBefore);
    expect(await fs.read(claimPath)).toBe(claimBefore);
    expect(await store.readPreparedInput(preparation.id)).toEqual({ schema_version: 1, kind: 'prepared_subagent_input' });
  });

  it('ordinary legacy uses only the lower prepare capability; unknown payload needs its owner', async () => {
    const { root, fs } = await fixture();
    const ordinary = prepared();
    const specialized = prepared({ owner: 'shadow', secret: 'opaque' });
    const prepareLegacyInput = vi.fn((declaration: { prompt: string }) => ({ prepared: declaration.prompt }));
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs,
      execution: { start: vi.fn(), open: vi.fn(), resume: vi.fn() },
      prepareLegacyInput,
      deliverySink: { deliver: vi.fn() },
    });
    await system.schedulePrepared('subagent', ordinary);
    await system.schedulePrepared('subagent', specialized);
    await system.initialize();

    expect(prepareLegacyInput).toHaveBeenCalledTimes(1);
    const remaining = await system.listUnpreparedInputs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: 'needs_owner_migration', taskId: specialized.id, payload: { owner: 'shadow' } });
    expect(await storeHas(fs, ordinary.id)).toBe(true);
    expect(await storeHas(fs, specialized.id)).toBe(false);
    await system.shutdown(1);
  });

  it('an invalid ordinary declaration is task-local and does not block other preparation', async () => {
    const { root, fs } = await fixture();
    const invalid = prepared();
    invalid.payload.intent = 'invalid';
    const ordinary = prepared();
    const specialized = prepared({ owner: 'unknown', opaque: true });
    const prepareLegacyInput = vi.fn((declaration: { prompt: string }) => {
      if (declaration.prompt === 'invalid') throw new TypeError('invalid legacy declaration');
      return { prepared: declaration.prompt };
    });
    const execution = makeTaskExecutionStub();
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs,
      execution,
      prepareLegacyInput,
      deliverySink: { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) },
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    await system.schedulePrepared('subagent', invalid);
    await system.schedulePrepared('subagent', ordinary);
    await system.schedulePrepared('subagent', specialized);

    await expect(system.initialize()).resolves.toBeUndefined();

    // The post-recovery pass retries the still-pending invalid declaration; the
    // already prepared ordinary task and unknown owner payload are not reprepared.
    expect(prepareLegacyInput).toHaveBeenCalledTimes(3);
    const attemptedPrompts = prepareLegacyInput.mock.calls.map(([declaration]) => declaration.prompt);
    expect(attemptedPrompts.filter(prompt => prompt === 'invalid')).toHaveLength(2);
    expect(attemptedPrompts.filter(prompt => prompt === 'legacy intent')).toHaveLength(1);
    expect(await storeHas(fs, invalid.id)).toBe(false);
    expect(await storeHas(fs, ordinary.id)).toBe(true);
    expect(await system.listUnpreparedInputs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ordinary_legacy', taskId: invalid.id }),
      expect.objectContaining({ kind: 'needs_owner_migration', taskId: specialized.id }),
    ]));

    await system.startDispatch();
    await vi.waitFor(() => expect(execution.start).toHaveBeenCalledTimes(1));
    expect(vi.mocked(execution.start).mock.calls[0][0].runId).toBe(ordinary.id);
    expect(await fs.exists(`tasks/queues/pending/${invalid.id}.json`)).toBe(true);
    expect(await fs.exists(`tasks/queues/pending/${specialized.id}.json`)).toBe(true);
    await system.shutdown(1);
  });

  it('requeues a running legacy Shadow payload for migration before dispatch without rewriting task or claim', async () => {
    const { root, fs } = await fixture();
    const auditWriter = audit();
    const execution = makeTaskExecutionStub();
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter, shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs,
      execution,
      deliverySink: { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) },
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    const preparation = prepared(legacyShadowPayload());
    await system.schedulePrepared('subagent', preparation);
    const pendingPath = `tasks/queues/pending/${preparation.id}.json`;
    const runningPath = `tasks/queues/running/${preparation.id}.json`;
    const claimPath = `tasks/queues/claims/${preparation.id}.json`;
    const taskBefore = await fs.read(pendingPath);
    const claimBefore = await fs.read(claimPath);
    await fs.move(pendingPath, runningPath);

    await system.initialize();

    expect(await fs.exists(pendingPath)).toBe(true);
    expect(await fs.exists(runningPath)).toBe(false);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.open).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
    expect(await fs.read(pendingPath)).toBe(taskBefore);
    expect(await fs.read(claimPath)).toBe(claimBefore);
    expect(auditWriter.write).toHaveBeenCalledWith(
      'task_recovery_failed',
      `taskId=${preparation.id}`,
      'context=execution_input_not_prepared',
      'error=task requeued pending owner input preparation; dispatch remains paused',
    );
    const [admitted] = await system.listUnpreparedInputs();
    expect(admitted).toMatchObject({
      kind: 'needs_owner_migration',
      taskId: preparation.id,
      sourcePath: pendingPath,
      sourceHash: sha256Hex(taskBefore),
    });

    const migrations = await migrateShadowTaskInputs(system);

    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({ kind: 'migrated', taskId: preparation.id });
    const sidecar = JSON.parse(await fs.read(`tasks/queues/results/${preparation.id}/${EXECUTION_INPUT_FILE}`)) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      taskId: preparation.id,
      sourcePath: pendingPath,
      sourceHash: sha256Hex(taskBefore),
      migrationSource: 'shadow_legacy_payload',
    });
    expect(await fs.read(pendingPath)).toBe(taskBefore);
    expect(await fs.read(claimPath)).toBe(claimBefore);
    expect(execution.start).not.toHaveBeenCalled();

    await system.startDispatch();
    await vi.waitFor(() => expect(execution.start).toHaveBeenCalledTimes(1));
    expect(vi.mocked(execution.start).mock.calls[0][0].input).toEqual(
      migrations[0].kind === 'migrated' ? migrations[0].input : undefined,
    );
    await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
    await system.shutdown(1);
  });

  it('prepares an ordinary running legacy task after safe requeue without executing during initialize', async () => {
    const { root, fs } = await fixture();
    const execution = makeTaskExecutionStub();
    const prepareLegacyInput = vi.fn((declaration: { prompt: string }) => ({ prepared: declaration.prompt }));
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs,
      execution,
      prepareLegacyInput,
      deliverySink: { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) },
    });
    const preparation = prepared();
    await system.schedulePrepared('subagent', preparation);
    const pendingPath = `tasks/queues/pending/${preparation.id}.json`;
    const runningPath = `tasks/queues/running/${preparation.id}.json`;
    const claimPath = `tasks/queues/claims/${preparation.id}.json`;
    const taskBefore = await fs.read(pendingPath);
    const claimBefore = await fs.read(claimPath);
    await fs.move(pendingPath, runningPath);

    await system.initialize();

    expect(prepareLegacyInput).toHaveBeenCalledTimes(1);
    expect(await fs.exists(pendingPath)).toBe(true);
    expect(await fs.exists(runningPath)).toBe(false);
    expect(await storeHas(fs, preparation.id)).toBe(true);
    const sidecar = JSON.parse(await fs.read(`tasks/queues/results/${preparation.id}/${EXECUTION_INPUT_FILE}`)) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      taskId: preparation.id,
      sourcePath: pendingPath,
      sourceHash: sha256Hex(taskBefore),
      migrationSource: 'ordinary_legacy',
      input: { prepared: 'legacy intent' },
    });
    expect(await fs.read(pendingPath)).toBe(taskBefore);
    expect(await fs.read(claimPath)).toBe(claimBefore);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.open).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
    await system.shutdown(1);
  });

  it('source hash changes fail explicitly before no-replace publication', async () => {
    const { root, fs } = await fixture();
    const system = legacySystem(root, fs);
    const preparation = prepared();
    await system.schedulePrepared('subagent', preparation);
    const store = createExecutionInputStore(fs);
    const [input] = await store.listUnpreparedInputs();
    const taskPath = `tasks/queues/pending/${preparation.id}.json`;
    await fs.writeAtomic(taskPath, `${await fs.read(taskPath)}\n`);

    await expect(store.commitPreparedInput({
      taskId: preparation.id, sourceHash: input.sourceHash,
      migrationSource: 'test', input: { prepared: true },
    })).rejects.toMatchObject({ code: 'source_changed' });
    expect(await storeHas(fs, preparation.id)).toBe(false);
  });

  it('conflicting commit retains both pieces of evidence and never replaces the winner', async () => {
    const { root, fs } = await fixture();
    const system = legacySystem(root, fs);
    const preparation = prepared();
    await system.schedulePrepared('subagent', preparation);
    const store = createExecutionInputStore(fs);
    const [input] = await store.listUnpreparedInputs();
    const request = { taskId: preparation.id, sourceHash: input.sourceHash, migrationSource: 'test' };
    await store.commitPreparedInput({ ...request, input: { winner: true } });
    const path = `tasks/queues/results/${preparation.id}/${EXECUTION_INPUT_FILE}`;
    const winner = await fs.read(path);

    let conflict: unknown;
    try {
      await store.commitPreparedInput({ ...request, input: { winner: false } });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(ExecutionInputStoreError);
    expect(conflict).toMatchObject({
      code: 'conflict',
      evidence: { existing: { input: { winner: true } }, attempted: { input: { winner: false } } },
    });
    expect(await fs.read(path)).toBe(winner);
    // Crash/retry of the exact same complete publication is an idempotent read.
    expect(await store.commitPreparedInput({ ...request, input: { winner: true } })).toMatchObject({ input: { winner: true } });
    expect(await fs.read(path)).toBe(winner);
  });

  it('active execution rejects migration even with a matching source hash', async () => {
    const { root, fs } = await fixture();
    const system = legacySystem(root, fs);
    const preparation = prepared();
    await system.schedulePrepared('subagent', preparation);
    const store = createExecutionInputStore(fs);
    const [input] = await store.listUnpreparedInputs();
    await fs.move(`tasks/queues/pending/${preparation.id}.json`, `tasks/queues/running/${preparation.id}.json`);

    await expect(store.commitPreparedInput({
      taskId: preparation.id, sourceHash: input.sourceHash,
      migrationSource: 'test', input: { prepared: true },
    })).rejects.toMatchObject({ code: 'active_execution' });
    expect(await storeHas(fs, preparation.id)).toBe(false);
  });

  it('a real in-process executingTasks entry rejects replacement without touching the prepared winner', async () => {
    const { root, fs } = await fixture();
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
    const execution = makeTaskExecutionStub(async identity => {
      await executionGate;
      return { identity, kind: 'completed', content: 'ok', recovery: 'none' };
    });
    const system = new AsyncTaskSystem(root, fs, {
      auditWriter: audit(), shortIdIndex: new InMemoryShortIdIndex(), registry: new ToolRegistryImpl(),
      fsFactory: () => fs,
      execution,
      prepareLegacyInput: () => ({ prepared: 'original' }),
      deliverySink: { deliver: vi.fn(async () => ({ kind: 'delivered' as const })) },
      createWatcher: createMockWatcherFactory(fs).factory,
    });
    const preparation = prepared();
    await system.schedulePrepared('subagent', preparation);
    await system.initialize();
    const sidecarPath = `tasks/queues/results/${preparation.id}/${EXECUTION_INPUT_FILE}`;
    const winnerBefore = await fs.read(sidecarPath);
    await system.startDispatch();
    await vi.waitFor(() => {
      expect(execution.start).toHaveBeenCalledTimes(1);
      expect(system.getInProcessRunningCount()).toBe(1);
    });

    try {
      const runningPath = `tasks/queues/running/${preparation.id}.json`;
      const runningSource = await fs.read(runningPath);
      await expect(system.commitPreparedInput({
        taskId: preparation.id,
        sourceHash: sha256Hex(runningSource),
        migrationSource: 'test_active_execution',
        input: { prepared: 'replacement' },
      })).rejects.toMatchObject({ code: 'active_execution' });
      expect(await fs.read(sidecarPath)).toBe(winnerBefore);
      expect(system.getInProcessRunningCount()).toBe(1);
    } finally {
      releaseExecution();
      await vi.waitFor(() => expect(system.getInProcessRunningCount()).toBe(0));
      await system.shutdown(1);
    }
  });
});

async function storeHas(fs: NodeFileSystem, taskId: string): Promise<boolean> {
  return fs.exists(`tasks/queues/results/${taskId}/${EXECUTION_INPUT_FILE}`);
}
