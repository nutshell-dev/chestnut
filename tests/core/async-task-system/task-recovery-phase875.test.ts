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

function makeToolTask(opts: { terminalState?: 'done' | 'failed'; mode?: 'fresh' | 'migrated'; migratedPid?: number } = {}) {
  return {
    kind: 'tool' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    toolName: 'read',
    args: {},
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
    terminalState: opts.terminalState,
    mode: opts.mode,
    migratedPid: opts.migratedPid,
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

describe('phase 875: migrated ToolTask terminalState + RECOVERED/DEAD_LETTER audit fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrated tool task with terminalState=failed moves to failed without migrated inference', async () => {
    const task = makeToolTask({ terminalState: 'failed', mode: 'migrated', migratedPid: 12345 });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists(taskFile)).toBe(false);

    const recovered = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recovered.length).toBe(1);
    expect(recovered[0]).toContain('reason=terminal_state_failed');

    const recoveryFailed = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
    expect(recoveryFailed.length).toBe(0);
  });

  it('emits RECOVERED when terminalState=done move succeeds', async () => {
    const task = makeToolTask({ terminalState: 'done' });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

    const recovered = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recovered.length).toBe(1);
    expect(recovered[0].some((col) => col === 'reason=terminal_state_done')).toBe(true);
    expect(recovered[0].some((col) => col === 'to=done')).toBe(true);
  });

  it('emits RECOVERED when terminalState=failed move succeeds', async () => {
    const task = makeToolTask({ terminalState: 'failed' });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

    const recovered = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recovered.length).toBe(1);
    expect(recovered[0].some((col) => col === 'reason=terminal_state_failed')).toBe(true);
    expect(recovered[0].some((col) => col === 'to=failed')).toBe(true);
  });

  it('does not emit RECOVERY_DEAD_LETTER when dead-letter move fails', async () => {
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

    const deadLetterEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER);
    expect(deadLetterEvents.length).toBe(0);

    const deadLetterMoveFailed = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=dead_letter_move_failed',
    );
    expect(deadLetterMoveFailed.length).toBe(1);
  });
});
