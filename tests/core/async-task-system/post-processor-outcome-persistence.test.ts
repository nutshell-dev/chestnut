/**
 * Phase 1396 Step J — authoritative processed outcome persistence.
 *
 * Characterization/ratchet:
 *  - subagent-executor writes durable post-process-input, then commits
 *    result-meta.json + result.txt before delivery.
 *  - result-meta.json is the classification authority; recovery uses it to
 *    resend the exact envelope without re-invoking the processor.
 *  - missing/throwing post-processor leaves the task in running and persists
 *    the input so recovery can replay after the registry is ready.
 *  - write failure during commit leaves the task in running for recovery retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import {
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  POST_PROCESS_INPUT_FILE,
  RESULT_META_FILE,
} from '../../../src/core/async-task-system/dirs.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import type { SubAgentTask, ToolRegistry } from '../../../src/core/async-task-system/types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import type { PostProcessor } from '../../../src/core/async-task-system/post-processors/types.js';
import { makeAudit } from '../../helpers/audit.js';

interface InMemoryFs extends FileSystem {
  files: Map<string, string>;
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
}) {
  return {
    fs,
    fsFactory: () => fs,
    auditWriter,
    llm: {} as LLMOrchestrator,
    registry: makeRegistry(),
    clawDir: '/tmp/test-claw',
    postProcessors: overrides?.postProcessors ?? new Map(),
    moveTaskToDone: vi.fn().mockResolvedValue(undefined),
    moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
    askMotionToolFactory: vi.fn().mockReturnValue({} as Tool),
    runSubagent: overrides?.runSubagent ?? (() => Promise.resolve({ text: 'raw result' })),
    sendResult: overrides?.sendResult ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe('Phase 1396 Step J: post-processor outcome persistence', () => {
  let fs: InMemoryFs;
  let audit: ReturnType<typeof makeAudit>;

  beforeEach(() => {
    fs = makeInMemoryFs();
    audit = makeAudit();
    vi.clearAllMocks();
  });

  it('executeSubAgentTask persists durable input + meta + text and delivers structured envelope', async () => {
    const task = makeSubAgentTask({ postProcessor: 'success' });
    const envelope = { schema_version: 1 as const, content: 'processed ok', isError: false, metadata: { k: 'v' } };
    const postProcessors = new Map<string, PostProcessor>([
      ['success', async () => envelope],
    ]);
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors,
      runSubagent: () => Promise.resolve({ text: 'raw result' }),
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    expect(fs.files.get(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)).toEqual(JSON.stringify({
      schema_version: 1,
      content: 'raw result',
      source_is_error: false,
    }));
    expect(JSON.parse(fs.files.get(`${resultDir}/${RESULT_META_FILE}`)!)).toEqual({
      schema_version: 1,
      is_error: false,
      metadata: { k: 'v' },
    });
    expect(fs.files.get(`${resultDir}/result.txt`)).toBe('processed ok');

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith(fs, audit.audit, task, envelope, { writeInboxAsync: undefined });
  });

  it('executeSubAgentTask defers and persists input when postProcessor is missing', async () => {
    const task = makeSubAgentTask({ postProcessor: 'missing' });
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, executorDeps(fs, audit.audit, {
      sendResult,
      postProcessors: new Map(),
    }));

    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    expect(fs.files.has(`${resultDir}/${POST_PROCESS_INPUT_FILE}`)).toBe(true);
    expect(sendResult).not.toHaveBeenCalled();
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED)).toBe(true);
  });

  it('executeSubAgentTask defers and persists input when postProcessor throws', async () => {
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
    expect(fs.files.has(`${resultDir}/result.txt`)).toBe(false);
    expect(sendResult).not.toHaveBeenCalled();
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.POST_PROCESSOR_DEFERRED)).toBe(true);
  });

  it('executeSubAgentTask leaves task in running when result commit fails', async () => {
    const task = makeSubAgentTask({ postProcessor: 'identity' });
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.setFailOnWrite(`${resultDir}/${RESULT_META_FILE}`);
    const postProcessors = new Map<string, PostProcessor>([
      ['identity', async (input) => ({ schema_version: 1 as const, content: input.content, isError: input.sourceIsError })],
    ]);
    const sendResult = vi.fn().mockResolvedValue(undefined);
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, {
      ...executorDeps(fs, audit.audit, { sendResult, postProcessors }),
      moveTaskToDone,
      moveTaskToFailed,
    });

    expect(sendResult).not.toHaveBeenCalled();
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
    expect(audit.events.some(e => e[0] === TASK_AUDIT_EVENTS.RESULT_DELIVERY_FAILED)).toBe(true);
  });
});

describe('Phase 1396 Step J: recovery authoritative outcome', () => {
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
      if (dir === 'tasks/queues/pending') return Promise.resolve([]);
      return Promise.resolve([]);
    });
  }

  function recoveryDeps(overrides?: {
    sendResult?: RecoverTasksDeps['sendResult'];
    sendFallbackError?: RecoverTasksDeps['sendFallbackError'];
    postProcessors?: Map<string, PostProcessor>;
  }): RecoverTasksDeps {
    return {
      fs,
      auditWriter: audit.audit,
      sendResult: overrides?.sendResult ?? vi.fn().mockResolvedValue(undefined),
      sendFallbackError: overrides?.sendFallbackError ?? vi.fn().mockResolvedValue(undefined),
      sendToolResult: vi.fn().mockResolvedValue(undefined),
      postProcessors: overrides?.postProcessors,
    };
  }

  it('recovery resends committed envelope using result-meta.json authority', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'final content');
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, JSON.stringify({
      schema_version: 1,
      is_error: true,
      metadata: { contractId: 'c-123' },
    }));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    const envelope = sendResult.mock.calls[0][3];
    expect(envelope).toEqual({
      schema_version: 1,
      content: 'final content',
      isError: true,
      metadata: { contractId: 'c-123' },
    });
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_RUNNING_DIR}/${task.id}.json`)).toBe(false);
  });

  it('recovery falls back to legacy is_error=false when result-meta.json is missing', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'legacy content');
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult }));

    const envelope = sendResult.mock.calls[0][3];
    expect(envelope.isError).toBe(false);
    expect(envelope.content).toBe('legacy content');
  });

  it('recovery replays durable input when only post-process-input.json exists', async () => {
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
    expect(JSON.parse(fs.files.get(`${resultDir}/${RESULT_META_FILE}`)!)).toEqual({
      schema_version: 1,
      is_error: true,
      metadata: undefined,
    });
    expect(fs.files.get(`${resultDir}/result.txt`)).toBe('replayed:raw from disk');
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(true);
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

  it('recovery uses fallback delivery when resend fails and writes sent marker', async () => {
    const task = makeSubAgentTask();
    seedRunningTask(task);
    const resultDir = `${TASKS_QUEUES_RESULTS_DIR}/${task.id}`;
    fs.files.set(`${resultDir}/result.txt`, 'committed');
    fs.files.set(`${resultDir}/${RESULT_META_FILE}`, JSON.stringify({
      schema_version: 1,
      is_error: true,
      metadata: { k: 'v' },
    }));
    const sendResult = vi.fn().mockRejectedValue(new Error('inbox full'));
    const sendFallbackError = vi.fn().mockResolvedValue(undefined);

    await recoverTasks(recoveryDeps({ sendResult, sendFallbackError }));

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(sendFallbackError).toHaveBeenCalledTimes(1);
    expect(sendFallbackError).toHaveBeenCalledWith(
      fs,
      audit.audit,
      task,
      'committed',
      true,
      { writeInboxAsync: undefined },
    );
    expect(fs.files.has(`${resultDir}/result.txt.sent`)).toBe(true);
    expect(fs.files.has(`${TASKS_QUEUES_DONE_DIR}/${task.id}.json`)).toBe(true);
  });
});
