/**
 * Task recovery invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - task-recovery-phase872.test.ts
 *  - task-recovery-phase874.test.ts
 *  - task-recovery-phase875.test.ts
 *  - task-recovery-phase904.test.ts
 *  - task-recovery-phase989.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
  sendFallbackError: vi.fn().mockRejectedValue(new Error('fallback fail')),
  sendToolResult: vi.fn().mockResolvedValue(undefined),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn(),
    getProcessStartTime: vi.fn(),
  };
});

describe('phase 872: recovery keeps running file + intended-failed marker', () => {
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

  function makeValidTask() {
    return {
      kind: 'subagent' as const,
      mode: 'standard' as const,
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      intent: 'test',
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      maxSteps: 1,
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
    };
  }

  function makeMockFsForPhase872(opts: {
    runningFiles?: Array<{ name: string; path: string; content: string }>;
    moveShouldFail?: boolean;
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
        return Promise.resolve([]);
      }),
      read: vi.fn().mockImplementation((filePath: string) => {
        const content = fileMap.get(filePath);
        if (content === undefined) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(content);
      }),
      move: vi.fn().mockImplementation((from: string, to: string) => {
        if (opts.moveShouldFail) {
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovery keeps running file when move to done fails', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      moveShouldFail: true,
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // running file must be preserved for next recovery retry
    expect(await mockFs.exists(taskFile)).toBe(true);

    // delete must NOT be called as a fallback
    expect(mockFs.delete).not.toHaveBeenCalledWith(taskFile);

    // recovery failure must be audited
    const moveFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=alreadysent_move_failed',
    );
    expect(moveFailedEvents.length).toBe(1);
  });

  it('recovery routes to failed when task has terminalState=failed', async () => {
    const task = { ...makeValidTask(), terminalState: 'failed' };
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // task should end up in failed/, not done/
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    // recovered event reason should reflect terminalState=failed routing
    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERED,
        expect.stringContaining('reason=terminal_state_failed'),
      ]),
    );
  });

  it('recovery routes to done when terminalState=done', async () => {
    const task = { ...makeValidTask(), terminalState: 'done' };
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // task should end up in done/
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERED,
        expect.stringContaining('reason=terminal_state_done'),
      ]),
    );
  });

  it('recovery routes to done when task has no terminalState (backward compat)', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // task should end up in done/
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERED,
        expect.stringContaining('reason=already_sent'),
      ]),
    );
  });

  it('does not emit RECOVERED when move fails', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      moveShouldFail: true,
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // running file must be preserved for next recovery retry
    expect(await mockFs.exists(taskFile)).toBe(true);

    // RECOVERED must NOT be emitted when move fails
    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(0);

    // RECOVERY_FAILED must be emitted
    const moveFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=alreadysent_move_failed',
    );
    expect(moveFailedEvents.length).toBe(1);
  });
});

describe('phase 874: ToolTask terminalState + dead-letter retry counter', () => {
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

describe('phase 875: migrated ToolTask terminalState + RECOVERED/DEAD_LETTER audit fix', () => {
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

describe('phase 904: migrated recovery radical fix', () => {
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

  function makeMigratedTask(opts: { createdAt?: string; migratedPid?: number } = {}) {
    return {
      kind: 'tool' as const,
      id: VALID_TASK_ID,
      shortId: VALID_TASK_SHORT_ID,
      toolName: 'read',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: opts.createdAt ?? new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 2,
      retryCount: 0,
      mode: 'migrated' as const,
      migratedPid: opts.migratedPid ?? 12345,
    };
  }

  function makeMockFs(opts: {
    runningFiles?: Array<{ name: string; path: string; content: string }>;
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('kills migrated process when hard timeout exceeded', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const task = makeMigratedTask({ createdAt: '2020-01-01T00:00:00Z' });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(killSpy).toHaveBeenCalledWith(task.migratedPid, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('keeps task in running when sendFallbackError fails', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const task = makeMigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(mockFs.move).not.toHaveBeenCalled();

    const fallbackFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=migrated_fallback_error_failed',
    );
    expect(fallbackFailedEvents.length).toBe(1);
  });

  it('keeps alive process in running when within deadline', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const task = makeMigratedTask({ createdAt: new Date().toISOString() });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(mockFs.move).not.toHaveBeenCalled();
  });
});

describe('phase 989 task-recovery sub-fixes', () => {
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

  function makeValidTask(kind: 'subagent' | 'tool' = 'subagent') {
    return {
      kind,
      mode: 'standard' as const,
      id: '550e8400-e29b-41d4-a716-446655440000',
      shortId: '550e8400',
      intent: 'test',
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      maxSteps: 1,
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
    };
  }

  function makeMockFsForPhase989(opts: {
    runningFiles?: Array<{ name: string; path: string; content: string }>;
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
        return Promise.resolve([]);
      }),
      read: vi.fn().mockImplementation((filePath: string) => {
        const content = fileMap.get(filePath);
        if (content === undefined) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(content);
      }),
      move: vi.fn().mockImplementation((from: string, to: string) => {
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats corrupt retry counter as dead-letter promotion (phase 989 C.2)', async () => {
    const task = makeValidTask('subagent');
    const taskFile = 'tasks/queues/running/task-1.json';
    const retryPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.retry-count';
    const resultPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt';

    const mockFs = makeMockFsForPhase989({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    // Pre-seed files so recovery takes the _recoverWithResult path
    await mockFs.writeAtomic(resultPath, 'result-content');
    await mockFs.writeAtomic(retryPath, 'abc');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // Verify: audit emitted retry_counter_corrupt
    const corruptEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=retry_counter_corrupt',
    );
    expect(corruptEvents.length).toBe(1);
    expect(corruptEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        expect.stringContaining('taskId='),
        'context=retry_counter_corrupt',
        expect.stringContaining('raw=abc'),
      ]),
    );

    // Verify: task moved to failed/ (dead-letter promotion)
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
  });

  it('_recoverAlreadySent deletes retryPath after move (phase 989 C.3)', async () => {
    const task = makeValidTask('subagent');
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';
    const retryPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.retry-count';

    const mockFs = makeMockFsForPhase989({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    // Pre-seed sentMarker (triggers alreadySent path) and retryPath (leftover)
    await mockFs.writeAtomic(sentMarker, '1');
    await mockFs.writeAtomic(retryPath, '2');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // Verify: task moved to done/
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

    // Verify: retryPath deleted (C.3 fix)
    expect(await mockFs.exists(retryPath)).toBe(false);
  });
});
