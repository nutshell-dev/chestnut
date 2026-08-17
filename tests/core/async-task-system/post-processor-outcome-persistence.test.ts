/**
 * Phase 1396 Step L — single authoritative result envelope.
 *
 * Characterization/ratchet:
 *  - processed-result-store is the only disk codec: `result-envelope.json`
 *    (single atomic write) is the sole authority for content/is_error/metadata;
 *    `result.txt` is a rebuildable, non-authoritative projection.
 *  - executor runs five phases: execution → persist post-process input →
 *    post-processor → commit envelope → deliver. A delivery failure never
 *    re-enters the processor nor overwrites the committed envelope.
 *  - recovery classifies done/failed from the committed envelope (or, for
 *    legacy formats, from reliable evidence only). Missing/corrupt/future
 *    envelopes never silently default to success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import {
  createProcessedResultStore,
  ProcessedResultCorruptError,
  ProcessedResultUnsupportedVersionError,
  ProcessedResultReadError,
} from '../../../src/core/async-task-system/processed-result-store.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import {
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  POST_PROCESS_INPUT_FILE,
  RESULT_META_FILE,
  RESULT_ENVELOPE_FILE,
} from '../../../src/core/async-task-system/dirs.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import type { SubAgentTask, ToolRegistry } from '../../../src/core/async-task-system/types.js';
import type { ProcessedTaskResult } from '../../../src/core/async-task-system/result-delivery-types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import type { PostProcessor } from '../../../src/core/async-task-system/post-processors/types.js';
import { makeAudit } from '../../helpers/audit.js';

interface InMemoryFs extends FileSystem {
  files: Map<string, string>;
  setFailOnWrite(path: string): void;
}

function makeInMemoryFs(): InMemoryFs {
  const files = new Map<string, string>();
  const failOnWrite = new Set<string>();

  const fs = {
    files,
    ensureDir: vi.fn().mockResolvedValue(undefined),
    ensureDirSync: vi.fn(),
    writeAtomic: vi.fn().mockImplementation((filePath: string, content: string) => {
      if (failOnWrite.has(filePath)) {
        return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      }
      files.set(filePath, content);
      return Promise.resolve(undefined);
    }),
    writeAtomicSync: vi.fn().mockImplementation((filePath: string, content: string) => {
      files.set(filePath, content);
    }),
    read: vi.fn().mockImplementation((filePath: string) => {
      if (!files.has(filePath)) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return Promise.resolve(files.get(filePath)!);
    }),
    readSync: vi.fn().mockImplementation((filePath: string) => {
      if (!files.has(filePath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(filePath)!;
    }),
    exists: vi.fn().mockImplementation((filePath: string) => Promise.resolve(files.has(filePath))),
    existsSync: vi.fn().mockImplementation((filePath: string) => files.has(filePath)),
    list: vi.fn().mockResolvedValue([]),
    listSync: vi.fn().mockReturnValue([]),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      if (!files.has(from)) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      files.set(to, files.get(from)!);
      files.delete(from);
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((filePath: string) => {
      files.delete(filePath);
      return Promise.resolve(undefined);
    }),
    deleteSync: vi.fn().mockImplementation((filePath: string) => {
      files.delete(filePath);
    }),
    appendSync: vi.fn().mockImplementation((filePath: string, content: string) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    }),
    setFailOnWrite(path: string) {
      failOnWrite.add(path);
    },
  } as unknown as InMemoryFs;

  return fs;
}

function makeRegistry(): ToolRegistry {
  return {
    formatForLLM: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    getForProfile: vi.fn().mockReturnValue([]),
    register: vi.fn(),
  } as unknown as ToolRegistry;
}

function makeSubAgentTask(overrides?: Partial<SubAgentTask>): SubAgentTask {
  return {
    kind: 'subagent',
    id: makeFullTaskId('550e8400-e29b-41d4-a716-446655440001'),
    shortId: makeShortTaskId('550e8401'),
    mode: 'standard',
    intent: 'test intent',
    timeoutMs: 300_000,
    maxSteps: 100,
    parentClawId: 'caller-claw',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function executorDeps(fs: FileSystem, auditWriter: AuditLog, overrides?: {
  sendResult?: RecoverTasksDeps['sendResult'];
  postProcessors?: Map<string, PostProcessor>;
  runSubagent?: () => Promise<{ text: string; capturedResult?: unknown }>;
  moveTaskToDone?: (taskId: SubAgentTask['id']) => Promise<void>;
  moveTaskToFailed?: (taskId: SubAgentTask['id']) => Promise<void>;
}) {
  return {
    fs,
    fsFactory: () => fs,
    auditWriter,
    llm: {} as LLMOrchestrator,
    registry: makeRegistry(),
    clawDir: '/tmp/test-claw',
    postProcessors: overrides?.postProcessors ?? new Map(),
    moveTaskToDone: overrides?.moveTaskToDone ?? vi.fn().mockResolvedValue(undefined),
    moveTaskToFailed: overrides?.moveTaskToFailed ?? vi.fn().mockResolvedValue(undefined),
    askMotionToolFactory: vi.fn().mockReturnValue({} as Tool),
    runSubagent: overrides?.runSubagent ?? (() => Promise.resolve({ text: 'raw result' })),
    sendResult: overrides?.sendResult ?? vi.fn().mockResolvedValue(undefined),
  };
}

function envelopeDiskJson(envelope: ProcessedTaskResult): string {
  return JSON.stringify({
    schema_version: 1,
    content: envelope.content,
    is_error: envelope.isError,
    ...(envelope.metadata !== undefined ? { metadata: envelope.metadata } : {}),
  });
}

describe('Phase 1396 Step L: processed-result-store', () => {
  let fs: InMemoryFs;

  beforeEach(() => {
    fs = makeInMemoryFs();
    vi.clearAllMocks();
  });

  it('commit writes a single atomic envelope file with snake_case disk keys; read round-trips to camelCase', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    const envelope: ProcessedTaskResult = {
      schema_version: 1,
      content: 'final answer',
      isError: true,
      metadata: { contractId: 'c-1' },
    };

    await store.commit(taskId, envelope);

    const path = `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`;
    expect(JSON.parse(fs.files.get(path)!)).toEqual({
      schema_version: 1,
      content: 'final answer',
      is_error: true,
      metadata: { contractId: 'c-1' },
    });
    // single writeAtomic call for the envelope — no dual-authority pair
    const envelopeWrites = vi.mocked(fs.writeAtomic).mock.calls.filter(([p]) => p === path);
    expect(envelopeWrites.length).toBe(1);

    await expect(store.read(taskId)).resolves.toEqual(envelope);
  });

  it('commit omits metadata key when undefined', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    await store.commit(taskId, { schema_version: 1, content: 'c', isError: false });
    const path = `${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`;
    expect(JSON.parse(fs.files.get(path)!)).toEqual({
      schema_version: 1,
      content: 'c',
      is_error: false,
    });
  });

  it('read returns undefined only when the envelope is absent', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    await expect(store.read(taskId)).resolves.toBeUndefined();
  });

  it('read rejects on corrupt JSON — never defaults to isError=false', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    fs.files.set(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`, '{not json');
    await expect(store.read(taskId)).rejects.toThrow(ProcessedResultCorruptError);
  });

  it('read rejects on schema violation (strict, unknown keys) — never defaults to isError=false', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    fs.files.set(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`, JSON.stringify({
      schema_version: 1,
      content: 'c',
      is_error: false,
      unexpected: true,
    }));
    await expect(store.read(taskId)).rejects.toThrow(ProcessedResultCorruptError);
  });

  it('read rejects on future schema_version — never defaults to isError=false', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    fs.files.set(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`, JSON.stringify({
      schema_version: 2,
      content: 'c',
      is_error: false,
    }));
    await expect(store.read(taskId)).rejects.toThrow(ProcessedResultUnsupportedVersionError);
  });

  it('read rejects with typed error on I/O failure', async () => {
    const files = new Map<string, string>();
    const ioFs = {
      ...fs,
      read: vi.fn().mockImplementation((p: string) => {
        if (p.endsWith(RESULT_ENVELOPE_FILE)) {
          return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
        }
        if (!files.has(p)) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve(files.get(p)!);
      }),
    } as unknown as FileSystem;
    const store = createProcessedResultStore(ioFs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    await expect(store.read(taskId)).rejects.toThrow(ProcessedResultReadError);
  });

  it('projectText writes the result.txt projection; projection failure does not touch the envelope', async () => {
    const store = createProcessedResultStore(fs);
    const taskId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440001');
    const envelope: ProcessedTaskResult = { schema_version: 1, content: 'proj content', isError: false };
    await store.commit(taskId, envelope);

    await store.projectText(taskId, envelope);
    expect(fs.files.get(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt`)).toBe('proj content');

    // projection failure leaves the committed envelope byte-identical
    const committedBefore = fs.files.get(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`);
    fs.setFailOnWrite(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/result.txt`);
    await expect(store.projectText(taskId, { ...envelope, content: 'changed' })).rejects.toThrow('disk full');
    expect(fs.files.get(`${TASKS_QUEUES_RESULTS_DIR}/${taskId}/${RESULT_ENVELOPE_FILE}`)).toBe(committedBefore);
  });

  it('migrateIntermediate returns absent when no Step J intermediate exists (incl. bare legacy result.txt)', async () => {
    const store = createProcessedResultStore(fs);
    const task = makeSubAgentTask();
    await expect(store.migrateIntermediate(task)).resolves.toBe('absent');

    // pre-Step-J legacy: bare result.txt without meta is NOT this store's concern
    fs.files.set(`${TASKS_QUEUES_RESULTS_DIR}/${task.id}/result.txt`, 'legacy');
    await expect(store.migrateIntermediate(task)).resolves.toBe('absent');
  });

  it('migrateIntermediate migrates a valid Step J meta+text pair into a committed envelope', async () => {
    const store = createProcessedResultStore(fs);
    const task = makeSubAgentTask();
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, JSON.stringify({
      schema_version: 1,
      is_error: true,
      metadata: { contractId: 'c-9' },
    }));
    fs.files.set(`${resultDir}/result.txt`, 'step J content');

    await expect(store.migrateIntermediate(task)).resolves.toBe('migrated');
    await expect(store.read(task.id)).resolves.toEqual({
      schema_version: 1,
      content: 'step J content',
      isError: true,
      metadata: { contractId: 'c-9' },
    });
  });

  it('migrateIntermediate is indeterminate on corrupt/future/half-written Step J intermediate', async () => {
    const store = createProcessedResultStore(fs);
    const task = makeSubAgentTask();
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;

    // corrupt meta JSON
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, '{broken');
    fs.files.set(`${resultDir}/result.txt`, 'content');
    await expect(store.migrateIntermediate(task)).resolves.toBe('indeterminate');
    expect(fs.files.has(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(false);

    // future meta version
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, JSON.stringify({ schema_version: 99, is_error: false }));
    await expect(store.migrateIntermediate(task)).resolves.toBe('indeterminate');

    // meta present but text missing (crash between Step J's two writes)
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, JSON.stringify({ schema_version: 1, is_error: false }));
    fs.files.delete(`${resultDir}/result.txt`);
    await expect(store.migrateIntermediate(task)).resolves.toBe('indeterminate');
  });
});

describe('Phase 1396 Step L: executor phases', () => {
  let fs: InMemoryFs;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    fs = makeInMemoryFs();
    audit = makeAudit();
    vi.clearAllMocks();
  });

  it('persists durable input + single envelope + text projection and delivers the structured envelope', async () => {
    const task = makeSubAgentTask({ postProcessor: 'success' });
    const envelope: ProcessedTaskResult = { schema_version: 1, content: 'processed ok', isError: false, metadata: { k: 'v' } };
    const postProcessors = new Map<string, PostProcessor>([['success', async () => envelope]]);
    const sendResult = vi.fn().mockResolvedValue(undefined);
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors,
      runSubagent: () => Promise.resolve({ text: 'raw result' }),
      moveTaskToDone,
      moveTaskToFailed,
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    expect(fs.files.get(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)).toEqual(JSON.stringify({
      schema_version: 1,
      content: 'raw result',
      source_is_error: false,
    }));
    expect(fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(envelopeDiskJson(envelope));
    expect(fs.files.get(`${resultDir}/result.txt`)).toBe('processed ok');

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith(fs, audit.audit, task, envelope, { writeInboxAsync: undefined });
    expect(moveTaskToDone).toHaveBeenCalledWith(task.id);
    expect(moveTaskToFailed).not.toHaveBeenCalled();
  });

  it('execution failure flows through the processor into an isError envelope and moves failed', async () => {
    const task = makeSubAgentTask();
    const sendResult = vi.fn().mockResolvedValue(undefined);
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      runSubagent: () => Promise.reject(new Error('subagent died')),
      moveTaskToDone,
      moveTaskToFailed,
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    const input = JSON.parse(fs.files.get(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)!);
    expect(input.source_is_error).toBe(true);
    expect(input.content).toContain('subagent died');

    const committed = JSON.parse(fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`)!);
    expect(committed.is_error).toBe(true);
    expect(committed.content).toContain('subagent died');

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult.mock.calls[0][3].isError).toBe(true);
    expect(moveTaskToFailed).toHaveBeenCalledWith(task.id);
    expect(moveTaskToDone).not.toHaveBeenCalled();
  });

  it('delivery failure after a successful processor run never re-enters the processor nor overwrites input/envelope', async () => {
    const task = makeSubAgentTask({ postProcessor: 'success' });
    const envelope: ProcessedTaskResult = { schema_version: 1, content: 'processed ok', isError: false, metadata: { k: 'v' } };
    const processor = vi.fn().mockResolvedValue(envelope);
    const postProcessors = new Map<string, PostProcessor>([['success', processor]]);
    const sendResult = vi.fn().mockRejectedValue(new Error('inbox full'));
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors,
      runSubagent: () => Promise.resolve({ text: 'raw result' }),
      moveTaskToDone,
      moveTaskToFailed,
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    expect(processor).toHaveBeenCalledTimes(1);
    // durable input keeps the original raw result — never overwritten by the delivery error
    expect(fs.files.get(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)).toBe(JSON.stringify({
      schema_version: 1,
      content: 'raw result',
      source_is_error: false,
    }));
    // committed envelope is still the original success outcome
    expect(fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(envelopeDiskJson(envelope));
    expect(sendResult).toHaveBeenCalledTimes(1);
    // delivery failure only affects delivery: task stays in running for recovery resend
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.RESULT_DELIVERY_FAILED)).toBe(true);
  });

  it('delivery failure on the execution-error path also keeps the original failure envelope (no double finalize)', async () => {
    const task = makeSubAgentTask();
    const sendResult = vi.fn().mockRejectedValue(new Error('inbox full'));
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      runSubagent: () => Promise.reject(new Error('subagent died')),
      moveTaskToDone,
      moveTaskToFailed,
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    const committed = JSON.parse(fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`)!);
    // envelope holds the ORIGINAL execution error — not a reclassified delivery error
    expect(committed.content).toContain('subagent died');
    expect(committed.is_error).toBe(true);
    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
  });

  it('defers and persists input when postProcessor is missing', async () => {
    const task = makeSubAgentTask({ postProcessor: 'missing' });
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors: new Map(),
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    expect(fs.files.has(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)).toBe(true);
    expect(fs.files.has(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(false);
    expect(sendResult).not.toHaveBeenCalled();
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED)).toBe(true);
  });

  it('defers and persists input when postProcessor throws', async () => {
    const task = makeSubAgentTask({ postProcessor: 'bad' });
    const postProcessors = new Map<string, PostProcessor>([
      ['bad', async () => { throw new Error('processor exploded'); }],
    ]);
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors,
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    expect(fs.files.has(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)).toBe(true);
    expect(fs.files.has(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(false);
    expect(fs.files.has(`${resultDir}/result.txt`)).toBe(false);
    expect(sendResult).not.toHaveBeenCalled();
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED)).toBe(true);
  });

  it('leaves task in running when the envelope commit fails', async () => {
    const task = makeSubAgentTask({ postProcessor: 'identity' });
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.setFailOnWrite(`${resultDir}/${RESULT_ENVELOPE_FILE}`);
    const postProcessors = new Map<string, PostProcessor>([
      ['identity', async (input) => ({ schema_version: 1 as const, content: input.content, isError: input.sourceIsError })],
    ]);
    const sendResult = vi.fn().mockResolvedValue(undefined);
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors,
      moveTaskToDone,
      moveTaskToFailed,
    }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
    expect(audit.events.some(e =>
      e[0] === TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED && e.some(c => String(c).includes('envelope_commit_failed')),
    )).toBe(true);
  });

  it('text projection failure is observable but does not block delivery or terminal move', async () => {
    const task = makeSubAgentTask();
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.setFailOnWrite(`${resultDir}/result.txt`);
    const sendResult = vi.fn().mockResolvedValue(undefined);
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      moveTaskToDone,
    }));

    // envelope committed; delivery still ran; terminal move still happened
    expect(fs.files.has(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(true);
    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(moveTaskToDone).toHaveBeenCalledWith(task.id);
    expect(audit.events.some(e =>
      e[0] === TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED && e.some(c => String(c).includes('result_text_projection_failed')),
    )).toBe(true);
  });
});

describe('Phase 1396 Step L: recovery classification from the committed envelope', () => {
  let fs: InMemoryFs;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    fs = makeInMemoryFs();
    audit = makeAudit();
    vi.clearAllMocks();
  });

  function seedRunningTask(task: SubAgentTask) {
    const taskPath = `${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`;
    fs.files.set(taskPath, JSON.stringify(task));
    fs.list = vi.fn().mockImplementation((dir: string) => {
      if (dir === TASKS_QUEUES_RUNNING_DIR) return Promise.resolve([{ name: `${task.id}.json`, path: taskPath }]);
      return Promise.resolve([]);
    });
  }

  function recoveryDeps(overrides?: {
    sendResult?: RecoverTasksDeps['sendResult'];
    sendFallbackResult?: RecoverTasksDeps['sendFallbackResult'];
    postProcessors?: Map<string, PostProcessor>;
  }): RecoverTasksDeps {
    return {
      fs,
      auditWriter: audit.audit,
      sendResult: overrides?.sendResult ?? vi.fn().mockResolvedValue(undefined),
      sendFallbackResult: overrides?.sendFallbackResult ?? vi.fn().mockResolvedValue(undefined),
      sendToolResult: vi.fn().mockResolvedValue(undefined),
      postProcessors: overrides?.postProcessors,
    };
  }

  it('recovery resends the committed failure envelope and moves to FAILED (not done)', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    const envelope: ProcessedTaskResult = {
      schema_version: 1,
      content: 'final failure',
      isError: true,
      metadata: { contractId: 'c-123' },
    };
    fs.files.set(`${resultDir}/${RESULT_ENVELOPE_FILE}`, envelopeDiskJson(envelope));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult.mock.calls[0][3]).toEqual(envelope);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(false);
  });

  it('recovery resends the committed success envelope and moves to done', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    const envelope: ProcessedTaskResult = { schema_version: 1, content: 'ok', isError: false };
    fs.files.set(`${resultDir}/${RESULT_ENVELOPE_FILE}`, envelopeDiskJson(envelope));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(false);
  });

  it('recovery replays durable input with isError=true and moves to FAILED (not done)', async () => {
    const task = makeSubAgentTask({ postProcessor: 'replay' });
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/${POST_PROCESS_INPUT_FILE}`, JSON.stringify({
      schema_version: 1,
      content: 'raw from disk',
      source_is_error: true,
    }));
    const postProcessors = new Map<string, PostProcessor>([
      ['replay', async (input) => ({ schema_version: 1 as const, content: `replayed:${input.content}`, isError: input.sourceIsError })],
    ]);
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult, postProcessors }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    const envelope = sendResult.mock.calls[0][3];
    expect(envelope.content).toBe('replayed:raw from disk');
    expect(envelope.isError).toBe(true);
    // replay committed the envelope before delivery
    expect(fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(envelopeDiskJson(envelope));
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('sent marker + committed failure envelope: no resend, moves to failed', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt.sent`, '1');
    fs.files.set(`${resultDir}/${RESULT_ENVELOPE_FILE}`, envelopeDiskJson({
      schema_version: 1, content: 'failed outcome', isError: true,
    }));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('sent marker + committed success envelope: no resend, moves to done', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt.sent`, '1');
    fs.files.set(`${resultDir}/${RESULT_ENVELOPE_FILE}`, envelopeDiskJson({
      schema_version: 1, content: 'ok outcome', isError: false,
    }));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(false);
  });

  it('sent marker + no envelope + terminalState=failed (legacy) routes to failed', async () => {
    const task = { ...makeSubAgentTask(), terminalState: 'failed' } as SubAgentTask;
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt.sent`, '1');

    await recoverTasks(recoveryDeps());

    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('sent marker + no envelope + no reliable evidence never defaults to done', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt.sent`, '1');

    await recoverTasks(recoveryDeps());

    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(false);
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.LEGACY_RESULT_CLASSIFICATION_UNKNOWN)).toBe(true);
  });

  it('fallback delivery receives the full envelope including metadata', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    const envelope: ProcessedTaskResult = {
      schema_version: 1,
      content: 'committed',
      isError: true,
      metadata: { k: 'v' },
    };
    fs.files.set(`${resultDir}/${RESULT_ENVELOPE_FILE}`, envelopeDiskJson(envelope));
    const sendResult = vi.fn().mockRejectedValue(new Error('inbox full'));
    const sendFallbackResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult, sendFallbackResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    expect(sendFallbackResult).toHaveBeenCalledWith(
      fs,
      audit.audit,
      task,
      envelope,
      { writeInboxAsync: undefined },
    );
    // fallback delivered → terminal move still follows envelope.isError
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('corrupt committed envelope keeps the task in running — never delivered as success', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/${RESULT_ENVELOPE_FILE}`, '{corrupt');
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
    expect(audit.events.some(e =>
      e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(c => String(c).includes('envelope_read_failed')),
    )).toBe(true);
  });

  it('Step J intermediate (result.txt + result-meta.json) migrates once into an envelope and classifies failed', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'step J content');
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, JSON.stringify({
      schema_version: 1,
      is_error: true,
      metadata: { contractId: 'c-7' },
    }));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult.mock.calls[0][3]).toEqual({
      schema_version: 1,
      content: 'step J content',
      isError: true,
      metadata: { contractId: 'c-7' },
    });
    expect(fs.files.has(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('Step J corrupt meta never defaults to success — task stays in running and is audited', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'step J content');
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, '{broken');
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
    expect(audit.events.some(e =>
      e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(c => String(c).includes('stepj_intermediate')),
    )).toBe(true);
  });

  it('pre-Step-J bare result.txt with terminalState=failed rebuilds the envelope and moves failed', async () => {
    const task = { ...makeSubAgentTask(), terminalState: 'failed' } as SubAgentTask;
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'legacy content');
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult.mock.calls[0][3]).toEqual({
      schema_version: 1,
      content: 'legacy content',
      isError: true,
    });
    expect(fs.files.has(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('pre-Step-J bare result.txt classified via typed task_completed audit (status=err → failed)', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'legacy content');
    fs.files.set('audit/audit.tsv', [
      '2026-08-17T00:00:00.000Z\t1\ttask_completed\tfullTaskId=other-task\tshortTaskId=other\tstatus=ok',
      `2026-08-17T00:00:01.000Z\t2\ttask_completed\tfullTaskId=${task.id}\tshortTaskId=${task.shortId}\tstatus=err`,
    ].join('\n'));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult.mock.calls[0][3].isError).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });

  it('pre-Step-J bare result.txt without reliable evidence stays running and is audited (no success guess)', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'legacy content');
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(false);
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.LEGACY_RESULT_CLASSIFICATION_UNKNOWN)).toBe(true);
  });

  it('recovery leaves task in running when input replay cannot resolve processor', async () => {
    const task = makeSubAgentTask({ postProcessor: 'not-registered' });
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/${POST_PROCESS_INPUT_FILE}`, JSON.stringify({
      schema_version: 1,
      content: 'raw from disk',
      source_is_error: false,
    }));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult, postProcessors: new Map() }));

    expect(sendResult).not.toHaveBeenCalled();
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(true);
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && String(e[2]).includes('post_process_replay_failed'))).toBe(true);
  });

  it('two restarts: committed envelope is never recomputed and classification stays stable across at-least-once delivery', async () => {
    const task = makeSubAgentTask({ postProcessor: 'replay' });
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/${POST_PROCESS_INPUT_FILE}`, JSON.stringify({
      schema_version: 1,
      content: 'raw from disk',
      source_is_error: true,
    }));
    const processor = vi.fn().mockImplementation(async (input: { content: string; sourceIsError: boolean }) => ({
      schema_version: 1 as const,
      content: `replayed:${input.content}`,
      isError: input.sourceIsError,
    }));
    const postProcessors = new Map<string, PostProcessor>([['replay', processor]]);

    // first restart: replay commits the envelope but delivery fails
    const failingSend = vi.fn().mockRejectedValue(new Error('inbox full'));
    const failingFallback = vi.fn().mockRejectedValue(new Error('inbox still full'));
    await recoverTasks(recoveryDeps({ sendResult: failingSend, sendFallbackResult: failingFallback, postProcessors }));

    expect(processor).toHaveBeenCalledTimes(1);
    const committedAfterFirst = fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`);
    expect(committedAfterFirst).toBeDefined();
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(true);

    // second restart: envelope exists → processor must NOT re-run; resend exact envelope
    const okSend = vi.fn().mockResolvedValue(undefined);
    await recoverTasks(recoveryDeps({ sendResult: okSend, postProcessors }));

    expect(processor).toHaveBeenCalledTimes(1);
    expect(fs.files.get(`${resultDir}/${RESULT_ENVELOPE_FILE}`)).toBe(committedAfterFirst);
    expect(okSend).toHaveBeenCalledTimes(1);
    expect(okSend.mock.calls[0][3]).toEqual({
      schema_version: 1,
      content: 'replayed:raw from disk',
      isError: true,
    });
    expect(fs.files.has(`${TASKS_QUEUES_FAILED_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(false);
  });
});
