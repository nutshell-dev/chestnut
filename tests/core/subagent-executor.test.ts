/** SubAgent task executor tests — prepared owner input and ATS lifecycle. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { executeSubAgentTask } from '../../src/core/async-task-system/subagent-executor.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../src/templates/prompts/subagent.js';
import type { SubAgentTask } from '../../src/core/async-task-system/system.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../helpers/test-timeouts.js';
import { prepareSubagentInput } from '../../src/core/subagent/index.js';
import { createCanonicalToolManifest } from '../../src/foundation/tools/index.js';
import {
  makePreparedInputStore,
  makeTaskExecutionStub,
} from '../helpers/task-system.js';

function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    kind: 'subagent',
    mode: 'standard',
    id: `task-${randomUUID()}`,
    intent: 'test intent',
    timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
    maxSteps: 10,
    parentClawId: 'parent-claw',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(task: SubAgentTask, failure?: Error) {
  const parentStreamLog = { write: vi.fn() };
  const input = prepareSubagentInput({
    prompt: task.intent,
    ...(task.systemPrompt !== undefined ? { systemPrompt: task.systemPrompt } : {}),
    tools: { manifest: createCanonicalToolManifest([]) },
    ...(task.toolProfile !== undefined ? { toolProfile: task.toolProfile } : {}),
    budget: { timeoutMs: task.timeoutMs, ...(task.maxSteps !== undefined ? { maxSteps: task.maxSteps } : {}) },
  });
  const execution = makeTaskExecutionStub(identity => failure
    ? { identity, kind: 'failed', content: failure.message, recovery: 'none', cause: failure }
    : { identity, kind: 'completed', content: 'result', recovery: 'none' });
  return {
    fs: {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      ensureDirSync: vi.fn(),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      appendSync: vi.fn(),
      read: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      exists: vi.fn().mockResolvedValue(false),
    } as unknown as import('../../src/foundation/fs/types.js').FileSystem,
    auditWriter: {
      write: vi.fn(), preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s),
    } as unknown as import('../../src/foundation/audit/index.js').AuditLog,
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawDir: path.join(tmpdir(), `subagent-exec-test-${randomUUID()}`),
    postProcessors: new Map(),
    moveTaskToDone: vi.fn().mockResolvedValue(undefined),
    moveTaskToFailed: vi.fn().mockResolvedValue(undefined),
    execution,
    inputStore: makePreparedInputStore(input),
    deliverySink: { deliver: vi.fn().mockResolvedValue({ kind: 'delivered', atLeastOnceWindow: true }) },
    parentStreamLog,
  };
}

describe('subagent-executor prepared input', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses the owner-prepared task.systemPrompt when provided', async () => {
    const task = makeTask({ systemPrompt: 'CUSTOM_PROMPT_X' });
    const deps = makeDeps(task);
    await executeSubAgentTask(task, new AbortController().signal, deps);

    expect(vi.mocked(deps.execution.start).mock.calls[0][0].input).toMatchObject({
      systemPrompt: { kind: 'text', text: 'CUSTOM_PROMPT_X' },
    });
  });

  it('lets SubAgent apply DEFAULT_SUBAGENT_SYSTEM_PROMPT when omitted', async () => {
    const task = makeTask();
    const deps = makeDeps(task);
    await executeSubAgentTask(task, new AbortController().signal, deps);

    expect(vi.mocked(deps.execution.start).mock.calls[0][0].input).toMatchObject({
      systemPrompt: { kind: 'text', text: DEFAULT_SUBAGENT_SYSTEM_PROMPT },
    });
  });

  it('emits parent task_completed even when the owner execution fails', async () => {
    const task = makeTask();
    const deps = makeDeps(task, new Error('subagent crashed'));
    await executeSubAgentTask(task, new AbortController().signal, deps);

    expect(deps.parentStreamLog.write).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'task_completed',
      taskId: task.id,
    }));
  });

  it('passes the owner canonical manifest and explicit profile through unchanged', async () => {
    const task = makeTask({ systemPrompt: 'X', toolProfile: 'subagent' });
    const deps = makeDeps(task);
    await executeSubAgentTask(task, new AbortController().signal, deps);

    expect(vi.mocked(deps.execution.start).mock.calls[0][0].input).toMatchObject({
      toolProfile: 'subagent',
      tools: { manifest: { revision: expect.any(String), llmTools: [] } },
    });
  });

  it('starts one owner reference per subagent task', async () => {
    const first = makeTask();
    const second = makeTask();
    const deps = makeDeps(first);
    await executeSubAgentTask(first, new AbortController().signal, deps);
    await executeSubAgentTask(second, new AbortController().signal, deps);

    expect(deps.execution.start).toHaveBeenCalledTimes(2);
  });
});
