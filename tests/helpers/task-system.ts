import { vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LLMOrchestrator } from '../../src/foundation/llm-orchestrator/index.js';
import type { ContractSystem } from '../../src/core/contract/manager.js';
import type { AuditWriter } from '../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { AsyncTaskSystem, type AsyncTaskSystemOptions } from '../../src/core/async-task-system/system.js';
import { createStandardDeliverySink } from '../../src/core/async-task-system/index.js';
import {
  createDefaultSubagentExecutionRunner,
  prepareSubagentInput,
} from '../../src/core/subagent/index.js';
import { InMemoryShortIdIndex } from '../../src/core/async-task-system/short-id-index.js';
import { ToolRegistryImpl } from '../../src/foundation/tools/registry.js';
import { createCanonicalToolManifest } from '../../src/foundation/tools/index.js';
import { makeSubagentRunFs } from './subagent-run-fs.js';
import { TASKS_QUEUES_PENDING_DIR } from '../../src/core/async-task-system/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import type {
  TaskExecutionIdentity,
  TaskExecutionPort,
  TaskExecutionQuery,
  TaskExecutionRef,
  TaskExecutionStartRequest,
  TaskExecutionResumeRequest,
  TaskSourceOutcome,
} from '../../src/core/async-task-system/types.js';
import type { OwnedExecutionInputStore } from '../../src/core/async-task-system/execution-input-store.js';
import type { Watcher, WatcherFactory, WatchEvent } from '../../src/foundation/file-watcher/index.js';

export function makeTestRegistry(): ToolRegistryImpl {
  return new ToolRegistryImpl();
}

export function makeTaskSystemDeps(
  llm?: LLMOrchestrator,
  fs: FileSystem = makeSubagentRunFs(),
  clawDir = '/test/claw',
): Pick<AsyncTaskSystemOptions, 'execution' | 'prepareLegacyInput' | 'deliverySink' | 'contractManager' | 'registry'> {
  const registry = makeTestRegistry();
  const executionLlm: LLMOrchestrator = llm ?? {
    call: vi.fn(),
    stream: vi.fn(),
    getProviderInfo: vi.fn(),
  };
  return {
    execution: createDefaultSubagentExecutionRunner({
      clawDir,
      syncDir: `${clawDir}/tasks/sync`,
      fs,
      llm: executionLlm,
      registry,
    }),
    prepareLegacyInput: declaration => prepareSubagentInput({
      ...declaration,
      tools: { manifest: createCanonicalToolManifest(registry.getAll()) },
    }),
    deliverySink: createStandardDeliverySink(),
    contractManager: {
      loadPaused: vi.fn(),
      resume: vi.fn(),
      setOnNotify: vi.fn(),
    } as unknown as ContractSystem,
    registry,
  };
}

/** Reference-port test double for ATS unit tests that do not exercise persistence. */
export function makeTaskExecutionStub(
  final: (
    identity: TaskExecutionIdentity,
    request: TaskExecutionStartRequest,
  ) => TaskSourceOutcome | Promise<TaskSourceOutcome> = identity => ({
    identity,
    kind: 'completed',
    content: 'ok',
    recovery: 'none',
  }),
): TaskExecutionPort {
  const refs = new Map<string, TaskExecutionRef>();
  const keyOf = (request: Pick<TaskExecutionStartRequest, 'runId' | 'resultDir'>) => `${request.runId}\0${request.resultDir}`;
  const create = async (request: TaskExecutionStartRequest): Promise<TaskExecutionRef> => {
    const identity: TaskExecutionIdentity = {
      runId: request.runId,
      resultDir: request.resultDir,
      attemptId: `${request.runId}-attempt`,
    };
    const outcome = await final(identity, request);
    const ref: TaskExecutionRef = {
      identity,
      completion: Promise.resolve(outcome),
      read: async () => ({ identity, sequence: 1, state: 'settled' as const, outcome }),
      observe: (listener: (view: import('../../src/core/async-task-system/types.js').TaskExecutionView) => void) => {
        listener({ identity, sequence: 1, state: 'settled', outcome });
        return () => {};
      },
      requestStop: vi.fn(async () => ({
        accepted: true,
        state: 'stopping' as const,
        persisted: true,
        durable: true,
      })),
    };
    refs.set(keyOf(request), ref);
    return ref;
  };
  const start = vi.fn(create);
  return {
    start,
    open: vi.fn(async (query: TaskExecutionQuery) => {
      const ref = refs.get(keyOf(query)) ?? await create({ ...query, input: undefined });
      const view = await ref.read();
      return {
        kind: 'found' as const,
        runId: query.runId,
        resultDir: query.resultDir,
        identity: ref.identity,
        view,
        ref,
        owner: 'settled' as const,
      };
    }),
    resume: vi.fn(async (request: TaskExecutionResumeRequest) => refs.get(keyOf(request)) ?? start(request)),
  };
}

/** Prepared-input boundary for executor unit tests; migration itself has dedicated disk tests. */
export function makePreparedInputStore(input: unknown = { kind: 'test-input' }): OwnedExecutionInputStore {
  return {
    listUnpreparedInputs: async () => [],
    commitPreparedInput: async () => { throw new Error('unexpected commit in prepared-input test double'); },
    hasPreparedInput: async () => true,
    readPreparedInput: async () => input,
  };
}

export function createTestTaskSystem(
  clawDir: string,
  fs: FileSystem,
  auditWriter: AuditWriter,
  llm?: LLMOrchestrator,
  overrides?: Partial<Omit<AsyncTaskSystemOptions, 'llm' | 'contractManager' | 'registry'>>,
): AsyncTaskSystem {
  const deps = makeTaskSystemDeps(llm, fs, clawDir);
  return new AsyncTaskSystem(clawDir, fs, {
    auditWriter,
    shortIdIndex: new InMemoryShortIdIndex(),
    ...deps,
    ...overrides,
  });
}

/**
 * phase 86: mock watcher factory that auto-fires 'add' events by intercepting
 * fs.writeAtomic calls. Eliminates chokidar OS-bound timing for fast project tests.
 *
 * Wraps fs.writeAtomic on first watcher creation and restores on last close().
 */
export function createMockWatcherFactory(fs: FileSystem): { factory: WatcherFactory } {
  let originalWriteAtomic: FileSystem['writeAtomic'] | null = null;
  const activeWatchers: Array<{
    watchPath: string;
    callback: (e: WatchEvent) => void;
    active: boolean;
  }> = [];

  const factory: WatcherFactory = (watchPath, callback, _opts) => {
    if (!originalWriteAtomic) {
      originalWriteAtomic = fs.writeAtomic.bind(fs);
      fs.writeAtomic = (async (p: string, content: string) => {
        // Phase 1869 (Step E 随改): 透传 AtomicWriteResult —— 原先吞掉返回值
        // 违反 FileSystem 契约，破坏消费写入结果的写入方（inbox-writer 耐久性三态消费）。
        const result = await originalWriteAtomic!(p, content);
        const resolved = fs.resolve(p);
        for (const w of activeWatchers) {
          if (!w.active) continue;
          if (resolved.startsWith(w.watchPath) && resolved.endsWith('.json')) {
            queueMicrotask(() => w.callback({ type: 'add', path: resolved }));
          }
        }
        return result;
      }) as FileSystem['writeAtomic'];
    }
    const entry = { watchPath, callback, active: true };
    activeWatchers.push(entry);

    return {
      close: async () => {
        entry.active = false;
        if (activeWatchers.every(w => !w.active) && originalWriteAtomic) {
          fs.writeAtomic = originalWriteAtomic;
          originalWriteAtomic = null;
        }
      },
      isActive: () => entry.active,
      getPath: () => watchPath,
    };
  };

  return { factory };
}

/**
 * Lightweight mock AsyncTaskSystem for unit tests that only need schedule().
 * Writes pending files directly to fs (mirror phase 1332 N2 migration).
 */
export function createMockTaskSystem(fs: FileSystem, auditWriter?: AuditLog): AsyncTaskSystem {
  return {
    schedule: async (_kind: 'subagent', payload: Record<string, unknown>) => {
      const taskId = randomUUID();
      const task = { ...payload, id: taskId, shortId: taskId.slice(0, 8), createdAt: new Date().toISOString() };
      await fs.writeAtomic(`${TASKS_QUEUES_PENDING_DIR}/${taskId}.json`, JSON.stringify(task, null, 2));
      if (auditWriter) {
        auditWriter.write('task_scheduled', `taskId=${taskId}`, `kind=subagent`);
      }
      return taskId;
    },
  } as unknown as AsyncTaskSystem;
}
