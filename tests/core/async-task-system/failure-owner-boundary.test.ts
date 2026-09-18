/**
 * Phase 1396 Step G — AsyncTaskSystem failure owner boundary.
 *
 * Characterization/ratchet: when a ToolTask or SubAgentTask fails,
 * executeToolTask / executeSubAgentTask must deliver exactly one
 * `task_result(is_error=true)` to the direct caller (`task.parentClawId`).
 *
 * Out of scope (and therefore zero calls in these tests):
 *   - motion inbox / motion routing
 *   - ContractSystem terminal mutation (fail/cancel)
 */

import { describe, it, expect, vi } from 'vitest';
import { executeToolTask } from '../../../src/core/async-task-system/tool-executor.js';
import { executeSubAgentTask } from '../../../src/core/async-task-system/subagent-executor.js';
import { makeMockAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { ToolRegistry } from '../../../src/foundation/tools/index.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import type { ToolTask, SubAgentTask } from '../../../src/core/async-task-system/types.js';

function makeFs(): FileSystem {
  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    ensureDirSync: vi.fn(),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    writeAtomicSync: vi.fn(),
    appendSync: vi.fn(),
    readSync: vi.fn().mockReturnValue(''),
    existsSync: vi.fn().mockReturnValue(true),
    listSync: vi.fn().mockReturnValue([]),
    deleteSync: vi.fn(),
    move: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileSystem;
}

function makeRegistry(): ToolRegistry {
  return {
    formatForLLM: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    getForProfile: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
}

function makeToolTask(): ToolTask {
  return {
    kind: 'tool',
    id: makeFullTaskId('550e8400-e29b-41d4-a716-446655440000'),
    shortId: makeShortTaskId('550e8400'),
    toolName: 'test_tool',
    args: {},
    parentClawDir: '/tmp/caller-claw',
    parentClawId: 'caller-claw',
    createdAt: new Date().toISOString(),
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
  };
}

function makeSubAgentTask(): SubAgentTask {
  return {
    kind: 'subagent',
    id: makeFullTaskId('550e8401-e29b-41d4-a716-446655440001'),
    shortId: makeShortTaskId('550e8401'),
    mode: 'standard',
    intent: 'test intent',
    timeoutMs: 300_000,
    maxSteps: 100,
    parentClawId: 'caller-claw',
    createdAt: new Date().toISOString(),
  };
}

describe('AsyncTaskSystem failure owner boundary (phase 1396 Step G)', () => {
  it('executeToolTask failure sends exactly one is_error=true result to parentClawId', async () => {
    const task = makeToolTask();
    const sendToolResult = vi.fn().mockResolvedValue(undefined);
    const sendFallbackResult = vi.fn().mockResolvedValue(undefined);
    const writeInboxAsync = vi.fn().mockResolvedValue(undefined);
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeToolTask(
      task,
      () => Promise.reject(new Error('tool blew up')),
      new AbortController().signal,
      {
        fs: makeFs(),
        auditWriter: makeMockAudit(),
        retryBaseDelayMs: 10,
        moveTaskToDone,
        moveTaskToFailed,
        sendToolResult,
        sendFallbackResult,
        writeInboxAsync,
      },
    );

    expect(moveTaskToFailed).toHaveBeenCalledTimes(1);
    expect(moveTaskToFailed).toHaveBeenCalledWith(task.id);
    expect(moveTaskToDone).not.toHaveBeenCalled();

    expect(sendToolResult).toHaveBeenCalledTimes(1);
    const [, , sentTask, sentResult, isError] = sendToolResult.mock.calls[0];
    expect(sentTask).toBe(task);
    expect(sentTask.parentClawId).toBe('caller-claw');
    expect(typeof sentResult === 'string' ? sentResult : sentResult.content).toContain('tool blew up');
    expect(isError).toBe(true);

    expect(sendFallbackResult).not.toHaveBeenCalled();
    expect(writeInboxAsync).not.toHaveBeenCalled();
  });

  it('executeSubAgentTask failure sends exactly one is_error=true result to parentClawId', async () => {
    const task = makeSubAgentTask();
    const deliver = vi.fn().mockResolvedValue({ kind: 'delivered', atLeastOnceWindow: true });
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, {
      fs: makeFs(),
      fsFactory: vi.fn().mockReturnValue(makeFs()),
      auditWriter: makeMockAudit(),
      clawDir: '/tmp/test-claw',
      postProcessors: new Map(),
      moveTaskToDone,
      moveTaskToFailed,
      // phase 1863 (AT-D5)：execution/delivery 经最小面注入
      taskExecutor: { execute: async () => ({ content: 'subagent died', sourceIsError: true, errorCategory: 'Error' }) },
      deliverySink: { deliver },
    });

    expect(moveTaskToFailed).toHaveBeenCalledTimes(1);
    expect(moveTaskToFailed).toHaveBeenCalledWith(task.id);
    expect(moveTaskToDone).not.toHaveBeenCalled();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [sentTask, sentEnvelope] = deliver.mock.calls[0];
    expect(sentTask).toBe(task);
    expect(sentTask.parentClawId).toBe('caller-claw');
    expect(sentEnvelope.content).toContain('subagent died');
    expect(sentEnvelope.isError).toBe(true);
  });

  it('executeSubAgentTask leaves task in running when delivery throws', async () => {
    const task = makeSubAgentTask();
    const deliver = vi.fn().mockRejectedValue(new Error('inbox full'));
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeSubAgentTask(task, new AbortController().signal, {
      fs: makeFs(),
      fsFactory: vi.fn().mockReturnValue(makeFs()),
      auditWriter: makeMockAudit(),
      clawDir: '/tmp/test-claw',
      postProcessors: new Map(),
      moveTaskToDone,
      moveTaskToFailed,
      taskExecutor: { execute: async () => ({ content: 'subagent died', sourceIsError: true, errorCategory: 'Error' }) },
      deliverySink: { deliver },
    });

    // Phase 1396 Step J: delivery failure does not fallback or move; the committed
    // envelope stays on disk and startup recovery will resend it.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(moveTaskToDone).not.toHaveBeenCalled();
    expect(moveTaskToFailed).not.toHaveBeenCalled();
  });
});
