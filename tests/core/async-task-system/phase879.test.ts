/**
 * Phase 879 — resultRef deletion ordering + isIdempotent guard + fallback dual IDs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendToolResult, sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';
import { executeToolTask } from '../../../src/core/async-task-system/tool-executor.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ToolTask } from '../../../src/core/async-task-system/types.js';
import * as messaging from '../../../src/foundation/messaging/index.js';

vi.mock('../../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    writeInboxAsync: vi.fn(),
  };
});

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

function makeMockFs(): FileSystem & { deletedPaths: string[] } {
  const fileMap = new Map<string, string>();
  const deletedPaths: string[] = [];
  return {
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockImplementation((filePath: string) => {
      const content = fileMap.get(filePath);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      const content = fileMap.get(from);
      fileMap.delete(from);
      if (content !== undefined) fileMap.set(to, content);
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((filePath: string) => {
      deletedPaths.push(filePath);
      fileMap.delete(filePath);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((filePath: string, content: string) => {
      fileMap.set(filePath, content);
      return Promise.resolve(undefined);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation((filePath: string) => Promise.resolve(fileMap.has(filePath))),
    deletedPaths,
  } as unknown as FileSystem & { deletedPaths: string[] };
}

function makeToolTask(overrides: Partial<ToolTask> = {}): ToolTask {
  return {
    kind: 'tool',
    id: '550e8400-e29b-41d4-a716-446655440000',
    shortId: '550e8400',
    toolName: 'read',
    args: {},
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
    ...overrides,
  } as ToolTask;
}

describe('phase 879: resultRef deletion ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves result.txt when both ref and inline inbox writes fail', async () => {
    vi.mocked(messaging.writeInboxAsync).mockRejectedValue(new Error('inbox write failed'));

    const mockFs = makeMockFs();
    const { audit } = makeMockAudit();
    const task = makeToolTask();
    const resultPath = `tasks/queues/results/${task.id}/result.txt`;

    await expect(sendToolResult(mockFs, audit, task, 'large result content', false)).rejects.toThrow('inbox write failed');

    // result.txt must still exist because inline fallback also failed
    expect(await mockFs.exists(resultPath)).toBe(true);
    expect(mockFs.deletedPaths).not.toContain(resultPath);
  });
});

describe('phase 879: isIdempotent guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not retry non-idempotent tool tasks', async () => {
    const task = makeToolTask({ isIdempotent: false, maxRetries: 2 });
    const executeCallback = vi.fn().mockRejectedValue(new Error('tool execution failed'));
    const moveTaskToDone = vi.fn().mockResolvedValue(undefined);
    const moveTaskToFailed = vi.fn().mockResolvedValue(undefined);

    await executeToolTask(
      task,
      executeCallback,
      new AbortController().signal,
      {
        fs: makeMockFs(),
        auditWriter: makeMockAudit().audit,
        retryBaseDelayMs: 1,
        moveTaskToDone,
        moveTaskToFailed,
      },
    );

    // Non-idempotent tool must not retry
    expect(executeCallback).toHaveBeenCalledTimes(1);
    expect(moveTaskToFailed).toHaveBeenCalledTimes(1);
    expect(moveTaskToDone).not.toHaveBeenCalled();
  });
});

describe('phase 879: fallback dual IDs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sendFallbackError uses shortId for taskId and full UUID for fullTaskId', async () => {
    const inboxMessages: Array<{ content: string }> = [];
    vi.mocked(messaging.writeInboxAsync).mockImplementation(async (_fs, _dir, message) => {
      inboxMessages.push({ content: message.content });
      return Promise.resolve(undefined);
    });

    const mockFs = makeMockFs();
    const { audit } = makeMockAudit();
    const task = makeToolTask();

    await sendFallbackError(mockFs, audit, task, 'fallback reason');

    expect(inboxMessages.length).toBe(1);
    const parsed = JSON.parse(inboxMessages[0]!.content);
    expect(parsed.taskId).toBe(task.shortId);
    expect(parsed.fullTaskId).toBe(task.id);
    expect(parsed.is_error).toBe(true);
    expect(parsed.result).toContain('fallback reason');
  });
});
