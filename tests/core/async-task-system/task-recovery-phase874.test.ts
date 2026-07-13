import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
  sendFallbackError: vi.fn().mockRejectedValue(new Error('fallback fail')),
  sendToolResult: vi.fn().mockResolvedValue(undefined),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

const VALID_TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_TASK_SHORT_ID = '550e8400';

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

function makeToolTask(terminalState?: 'done' | 'failed') {
  return {
    kind: 'tool' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    toolName: 'read',
    args: {},
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
    terminalState,
  };
}

function makeSubAgentTask() {
  return {
    kind: 'subagent' as const,
    mode: 'standard' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    intent: 'test',
    timeoutMs: 1000,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  };
}

function makeMockFs(opts: {
  runningFiles?: Array<{ name: string; path: string; content: string }>;
  deadLetterMoveShouldFail?: boolean;
} = {}): FileSystem {
  const running = opts.runningFiles ?? [];
  const fileMap = new Map<string, string>();

  for (const f of running) fileMap.set(f.path, f.content);

  return {
    list: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'tasks/queues/running') {
        return Promise.resolve(running.map((f) => ({ name: f.name, path: f.path })));
      }
      if (dir === 'tasks/queues/pending') {
        return Promise.resolve([]);
      }
      if (dir === 'tasks/queues/failed') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    read: vi.fn().mockImplementation((filePath: string) => {
      const content = fileMap.get(filePath);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      if (opts.deadLetterMoveShouldFail && to.includes('/failed/')) {
        return Promise.reject(new Error('disk full'));
      }
      const content = fileMap.get(from);
      fileMap.delete(from);
      if (content !== undefined) {
        fileMap.set(to, content);
      }
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((filePath: string) => {
      fileMap.delete(filePath);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((filePath: string, content: string) => {
      fileMap.set(filePath, content);
      return Promise.resolve(undefined);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation((filePath: string) => {
      return Promise.resolve(fileMap.has(filePath));
    }),
  } as unknown as FileSystem;
}

describe('phase 874: ToolTask terminalState + dead-letter retry counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovers tool task with terminalState=done to done', async () => {
    const task = makeToolTask('done');
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/pending/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);
    expect(await mockFs.exists(taskFile)).toBe(false);

    const moveCalls = vi.mocked(mockFs.move).mock.calls;
    expect(moveCalls.some(([from, to]) => from === taskFile && to === 'tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(moveCalls.some(([, to]) => to === 'tasks/queues/pending/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const recoveryFailed = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
    expect(recoveryFailed.length).toBe(0);
  });

  it('recovers tool task with terminalState=failed to failed', async () => {
    const task = makeToolTask('failed');
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/pending/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);
    expect(await mockFs.exists(taskFile)).toBe(false);

    const moveCalls = vi.mocked(mockFs.move).mock.calls;
    expect(moveCalls.some(([from, to]) => from === taskFile && to === 'tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(moveCalls.some(([, to]) => to === 'tasks/queues/pending/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const recoveryFailed = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
    expect(recoveryFailed.length).toBe(0);
  });

  it('keeps retry counter when dead-letter move fails', async () => {
    const task = makeSubAgentTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt';
    const retryPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.retry-count';

    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      deadLetterMoveShouldFail: true,
    });
    await mockFs.writeAtomic(resultPath, 'result content');
    await mockFs.writeAtomic(retryPath, '2');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // running file must be preserved for next recovery retry
    expect(await mockFs.exists(taskFile)).toBe(true);
    // retry counter must remain (incremented to 3, not deleted)
    expect(await mockFs.exists(retryPath)).toBe(true);
    expect(await mockFs.read(retryPath)).toBe('3');

    const deadLetterMoveFailed = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=dead_letter_move_failed',
    );
    expect(deadLetterMoveFailed.length).toBe(1);
  });
});
