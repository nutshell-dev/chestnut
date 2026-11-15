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

function makeRecoverDeps(fs: FileSystem, auditWriter: AuditLog): RecoverTasksDeps {
  return {
    fs,
    auditWriter,
    sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
    sendFallbackResult: vi.fn().mockRejectedValue(new Error('fallback fail')),
    sendToolResult: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn(),
    getProcessStartTime: vi.fn(),
    observeExecutionTarget: vi.fn(),
    terminateExecutionTarget: vi.fn(),
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
        if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
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
    const resultDir = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      moveShouldFail: true,
    });

    // Step L: the terminal move is driven by the committed success envelope.
    await mockFs.writeAtomic(`${resultDir}/result.txt.sent`, '1');
    await mockFs.writeAtomic(`${resultDir}/result-envelope.json`, JSON.stringify({
      schema_version: 1,
      content: 'ok',
      is_error: false,
    }));

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    // running file must be preserved for next recovery retry
    expect(await mockFs.exists(taskFile)).toBe(true);

    // delete must NOT be called as a fallback
    expect(mockFs.delete).not.toHaveBeenCalledWith(taskFile);

    // recovery failure must be audited
    const moveFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=envelope_terminal_move_failed',
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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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

  it('recovery does not default to done when sent marker exists but no envelope/terminalState evidence (Step L)', async () => {
    // Phase 1396 Step L: terminal classification comes from the committed
    // envelope; a bare sent marker without any reliable evidence must stay in
    // running and be audited — never silently defaulted to success.
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    // task must stay in running/ — classification is indeterminate
    expect(await mockFs.exists(taskFile)).toBe(true);
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const unknownEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.LEGACY_RESULT_CLASSIFICATION_UNKNOWN);
    expect(unknownEvents.length).toBe(1);
  });

  it('recovery classifies from the committed envelope when sent marker exists but terminalState is unwritten (Step L)', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultDir = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(`${resultDir}/result.txt.sent`, '1');
    await mockFs.writeAtomic(`${resultDir}/result-envelope.json`, JSON.stringify({
      schema_version: 1,
      content: 'failed outcome',
      is_error: true,
    }));

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    // envelope is_error=true → failed, even without terminalState
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
  });

  it('does not emit RECOVERED when move fails', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultDir = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      moveShouldFail: true,
    });

    // Step L: the terminal move is driven by the committed success envelope.
    await mockFs.writeAtomic(`${resultDir}/result.txt.sent`, '1');
    await mockFs.writeAtomic(`${resultDir}/result-envelope.json`, JSON.stringify({
      schema_version: 1,
      content: 'ok',
      is_error: false,
    }));

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    // running file must be preserved for next recovery retry
    expect(await mockFs.exists(taskFile)).toBe(true);

    // RECOVERED must NOT be emitted when move fails
    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(0);

    // RECOVERY_FAILED must be emitted
    const moveFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=envelope_terminal_move_failed',
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
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
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
        if (content === undefined) {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
    // Phase 1396 Step L: retry/dead-letter delivery applies to a committed envelope.
    const envelopePath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result-envelope.json';
    const retryPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.retry-count';

    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      deadLetterMoveShouldFail: true,
    });
    await mockFs.writeAtomic(envelopePath, JSON.stringify({ schema_version: 1, content: 'result content', is_error: false }));
    await mockFs.writeAtomic(retryPath, '2');

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
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
        if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

    const recovered = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recovered.length).toBe(1);
    expect(recovered[0].some((col) => col === 'reason=terminal_state_failed')).toBe(true);
    expect(recovered[0].some((col) => col === 'to=failed')).toBe(true);
  });

  it('does not emit RECOVERY_DEAD_LETTER when dead-letter move fails', async () => {
    const task = makeSubAgentTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    // Phase 1396 Step L: retry/dead-letter delivery applies to a committed envelope.
    const envelopePath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result-envelope.json';
    const retryPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.retry-count';

    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      deadLetterMoveShouldFail: true,
    });
    await mockFs.writeAtomic(envelopePath, JSON.stringify({ schema_version: 1, content: 'result content', is_error: false }));
    await mockFs.writeAtomic(retryPath, '2');

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    const deadLetterEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER);
    expect(deadLetterEvents.length).toBe(0);

    const deadLetterMoveFailed = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=dead_letter_move_failed',
    );
    expect(deadLetterMoveFailed.length).toBe(1);
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
        if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
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
    // Phase 1396 Step L: retry/dead-letter delivery applies to a committed envelope.
    const envelopePath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result-envelope.json';

    const mockFs = makeMockFsForPhase989({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    // Pre-seed files so recovery takes the committed-envelope resend path
    await mockFs.writeAtomic(envelopePath, JSON.stringify({ schema_version: 1, content: 'result-content', is_error: false }));
    await mockFs.writeAtomic(retryPath, 'abc');

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

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
    const resultDir = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000';
    const sentMarker = `${resultDir}/result.txt.sent`;
    const retryPath = `${resultDir}/result.txt.retry-count`;

    const mockFs = makeMockFsForPhase989({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    // Pre-seed sentMarker (triggers alreadySent path), a committed success
    // envelope (Step L classification authority), and retryPath (leftover)
    await mockFs.writeAtomic(sentMarker, '1');
    await mockFs.writeAtomic(`${resultDir}/result-envelope.json`, JSON.stringify({
      schema_version: 1,
      content: 'ok',
      is_error: false,
    }));
    await mockFs.writeAtomic(retryPath, '2');

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    // Verify: task moved to done/
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

    // Verify: retryPath deleted (C.3 fix)
    expect(await mockFs.exists(retryPath)).toBe(false);
  });
});

describe('phase 1269 Step E: migrated execution-group recovery', () => {
  const VALID_TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
  const VALID_TASK_SHORT_ID = '550e8400';
  const LEADER_PID = 22222;
  const TARGET = {
    version: 1 as const,
    leaderPid: LEADER_PID,
    processGroupId: LEADER_PID,
    leaderStartTime: 'Mon Jan 01 00:00:00 2020',
  };
  const EVIDENCE = { version: 1 as const, atMs: 0, facts: [] };
  const aliveObservation = () => ({ kind: 'alive' as const, target: TARGET, evidence: EVIDENCE });
  const goneObservation = () => ({
    kind: 'gone' as const, target: TARGET, reason: 'absent' as const, evidence: EVIDENCE,
  });
  const unknownObservation = (reason: string) => ({
    kind: 'unknown' as const, target: TARGET, reason, evidence: EVIDENCE,
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

  function makeV1MigratedTask(extra: Record<string, unknown> = {}) {
    return {
      kind: 'tool' as const,
      id: VALID_TASK_ID,
      shortId: VALID_TASK_SHORT_ID,
      toolName: 'exec',
      args: { command: 'sleep 9999' },
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: '2020-01-01T00:00:00Z',
      isIdempotent: false,
      maxRetries: 0,
      retryCount: 0,
      mode: 'migrated' as const,
      migratedExecution: {
        version: 1 as const,
        leaderPid: LEADER_PID,
        processGroupId: LEADER_PID,
        leaderStartTime: 'Mon Jan 01 00:00:00 2020',
      },
      migratedDeadlineMs: 1, // already past
      ...extra,
    };
  }

  function makeMockFs(
    runningFiles: Array<{ name: string; path: string; content: string }>,
  ): FileSystem {
    const fileMap = new Map<string, string>();
    for (const f of runningFiles) fileMap.set(f.path, f.content);

    return {
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir === 'tasks/queues/running') {
          return Promise.resolve(runningFiles.map((f) => ({ name: f.name, path: f.path })));
        }
        return Promise.resolve([]);
      }),
      read: vi.fn().mockImplementation((filePath: string) => {
        const content = fileMap.get(filePath);
        if (content === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve(content);
      }),
      move: vi.fn().mockImplementation((from: string, to: string) => {
        const content = fileMap.get(from);
        fileMap.delete(from);
        if (content !== undefined) fileMap.set(to, content);
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
      append: vi.fn().mockImplementation((filePath: string, content: string) => {
        fileMap.set(filePath, (fileMap.get(filePath) ?? '') + content);
        return Promise.resolve(undefined);
      }),
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((filePath: string) => {
        return Promise.resolve(fileMap.has(filePath));
      }),
    } as unknown as FileSystem;
  }

  async function importProcessExecMocks() {
    const mod = await import('../../../src/foundation/process-exec/index.js');
    return {
      observeExecutionTarget: vi.mocked(mod.observeExecutionTarget),
      terminateExecutionTarget: vi.mocked(mod.terminateExecutionTarget),
    };
  }

  function goneGroupOutcome() {
    return {
      status: 'gone' as const,
      identity: { leaderPid: LEADER_PID, processGroupId: LEADER_PID },
      trigger: 'caller_requested' as const,
      termSent: true,
      killSent: false,
      completedAt: new Date().toISOString(),
      evidence: EVIDENCE,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commits a gone checkpoint intent to failed without normal result delivery', async () => {
    const mocks = await importProcessExecMocks();
    const outcome = goneGroupOutcome();
    const task = makeV1MigratedTask({
      migratedExecTerminalIntent: {
        version: 1,
        stage: 'result_initial_write',
        error: 'injected checkpoint EIO',
        termination: outcome,
        evidence: outcome.evidence,
      },
    });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    const sendToolResult = vi.fn();

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit, sendToolResult });

    expect(mocks.observeExecutionTarget).not.toHaveBeenCalled();
    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();
    expect(sendToolResult).not.toHaveBeenCalled();
    const exitPath = `tasks/queues/results/${VALID_TASK_ID}/exit.json`;
    expect(JSON.parse(await mockFs.read(exitPath))).toMatchObject({
      version: 1,
      taskId: VALID_TASK_ID,
      classification: 'error',
      termination: { status: 'gone' },
    });
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);
    expect(await mockFs.exists(taskFile)).toBe(false);
  });

  it('retries terminal-intent exit persistence without moving before the record is durable', async () => {
    const outcome = goneGroupOutcome();
    const task = makeV1MigratedTask({
      migratedExecTerminalIntent: {
        version: 1,
        stage: 'short_id_index_save',
        error: 'index write failed',
        termination: outcome,
        evidence: outcome.evidence,
      },
    });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    const originalWriteAtomic = mockFs.writeAtomic;
    let failExitWrite = true;
    mockFs.writeAtomic = vi.fn(async (filePath: string, content: string) => {
      if (failExitWrite && filePath.endsWith('/exit.json')) throw new Error('injected recovery exit EIO');
      await originalWriteAtomic(filePath, content);
    });
    const { audit } = makeMockAudit();
    const deps = { fs: mockFs, auditWriter: audit, sendToolResult: vi.fn(), sendFallbackResult: vi.fn() };

    await recoverTasks(deps);
    expect(await mockFs.exists(taskFile)).toBe(true);
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(false);
    expect(mockFs.move).not.toHaveBeenCalled();

    failExitWrite = false;
    await recoverTasks(deps);
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);
    expect(deps.sendToolResult).not.toHaveBeenCalled();
    expect(deps.sendFallbackResult).not.toHaveBeenCalled();
  });

  it('recovers an output persistence failure without fabricating a termination record', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(goneObservation());
    const task = makeV1MigratedTask({
      migratedExecTerminalIntent: {
        version: 1,
        stage: 'output_append',
        error: 'injected append EIO',
        evidence: EVIDENCE,
      },
    });
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    await mockFs.writeAtomic(resultPath, 'partial output');
    const sendToolResult = vi.fn();

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit, sendToolResult });

    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();
    expect(sendToolResult).not.toHaveBeenCalled();
    expect(JSON.parse(await mockFs.read(`tasks/queues/results/${VALID_TASK_ID}/exit.json`))).toMatchObject({
      classification: 'error',
      evidence: EVIDENCE,
    });
    expect(JSON.parse(await mockFs.read(`tasks/queues/results/${VALID_TASK_ID}/exit.json`)).termination).toBeUndefined();
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);
  });

  it('resumes a still-alive checkpoint intent from a fresh gone observation', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(goneObservation());
    const task = makeV1MigratedTask({
      migratedExecTerminalIntent: {
        version: 1,
        stage: 'result_dir_create',
        error: 'injected result dir EIO',
        termination: {
          status: 'still_alive',
          trigger: 'caller_requested',
          termSent: true,
          killSent: false,
          checkedAt: new Date().toISOString(),
        },
        evidence: EVIDENCE,
      },
    });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    const sendToolResult = vi.fn();
    const sendFallbackResult = vi.fn();

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit, sendToolResult, sendFallbackResult });

    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();
    expect(sendToolResult).not.toHaveBeenCalled();
    expect(sendFallbackResult).not.toHaveBeenCalled();
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);
    expect(JSON.parse(await mockFs.read(`tasks/queues/results/${VALID_TASK_ID}/exit.json`))).toMatchObject({
      classification: 'error',
      termination: { status: 'still_alive' },
      evidence: EVIDENCE,
    });
  });

  it('keeps a checkpoint intent running when recovery termination is still not gone', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(aliveObservation());
    mocks.terminateExecutionTarget.mockResolvedValue({
      status: 'still_alive',
      identity: { leaderPid: LEADER_PID, processGroupId: LEADER_PID },
      trigger: 'caller_requested',
      termSent: true,
      killSent: true,
      checkedAt: new Date().toISOString(),
      evidence: EVIDENCE,
    });
    const task = makeV1MigratedTask({
      migratedExecTerminalIntent: {
        version: 1,
        stage: 'short_id_index_save',
        error: 'index write failed',
        termination: {
          status: 'indeterminate',
          trigger: 'caller_requested',
          termSent: true,
          killSent: false,
          reason: 'timeout',
        },
      },
    });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit, sendToolResult: vi.fn(), sendFallbackResult: vi.fn() });

    expect(mocks.terminateExecutionTarget).toHaveBeenCalledWith(TARGET, 'caller_requested');
    expect(await mockFs.exists(taskFile)).toBe(true);
    expect(await mockFs.exists(`tasks/queues/results/${VALID_TASK_ID}/exit.json`)).toBe(false);
    expect(mockFs.move).not.toHaveBeenCalled();
  });

  it('verified group past deadline is terminated via L1 group path, then delivered', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(aliveObservation());
    mocks.terminateExecutionTarget.mockResolvedValue(goneGroupOutcome());

    const sendToolResult = vi.fn().mockResolvedValue(undefined);
    const task = makeV1MigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    await mockFs.writeAtomic(resultPath, 'partial output');

    const { audit, events } = makeMockAudit();
    await recoverTasks({
      fs: mockFs,
      auditWriter: audit,
      sendResult: vi.fn(),
      sendFallbackResult: vi.fn(),
      sendToolResult,
    });

    // Recovery must terminate the whole group via L1 — never just assert the leader died.
    expect(mocks.terminateExecutionTarget).toHaveBeenCalledWith(
      TARGET,
      'caller_requested',
    );

    // Termination outcome audited with identity + outcome columns.
    const termEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
    expect(termEvents.length).toBe(1);
    expect(termEvents[0]).toContain('context=recovery_hard_timeout');
    expect(termEvents[0]).toContain(`leader_pid=${LEADER_PID}`);
    expect(termEvents[0]).toContain(`process_group_id=${LEADER_PID}`);
    expect(termEvents[0]).toContain('status=gone');

    // Result delivered with the recovery-kill note and task moved to done.
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    const delivered = sendToolResult.mock.calls[0][3] as string;
    expect(delivered).toContain('partial output');
    expect(delivered).toContain('[Process killed by recovery: hard timeout exceeded]');
    expect(delivered).not.toContain('may be truncated');
    expect(await mockFs.exists(`tasks/queues/done/${VALID_TASK_ID}.json`)).toBe(true);
  });

  it('indeterminate probe holds task in running within deadline: no signal, no move, no delivery', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(unknownObservation('leader_gone_group_alive'));

    const sendToolResult = vi.fn().mockResolvedValue(undefined);
    const task = makeV1MigratedTask({ migratedDeadlineMs: Date.now() + 3_600_000 });
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    await mockFs.writeAtomic(resultPath, 'partial output');

    const { audit, events } = makeMockAudit();
    await recoverTasks({
      fs: mockFs,
      auditWriter: audit,
      sendResult: vi.fn(),
      sendFallbackResult: vi.fn(),
      sendToolResult,
    });

    // Safety: leader gone but group still responds → possible PGID reuse.
    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();
    expect(sendToolResult).not.toHaveBeenCalled();
    expect(mockFs.move).not.toHaveBeenCalled();
    expect(await mockFs.exists(taskFile)).toBe(true);

    const holdEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some((c) => c === 'context=migrated_exec_probe_indeterminate'),
    );
    expect(holdEvents.length).toBe(1);
    expect(holdEvents[0].some((c) => typeof c === 'string' && c.includes('leader_gone_group_alive'))).toBe(true);
  });

  it('indeterminate probe past deadline notifies manual intervention once, writes marker, moves to failed', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(unknownObservation('leader_gone_group_alive'));

    const sendFallbackResult = vi.fn().mockResolvedValue(undefined);
    const task = makeV1MigratedTask(); // migratedDeadlineMs: 1 → already past
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);

    const { audit, events } = makeMockAudit();
    await recoverTasks({
      fs: mockFs,
      auditWriter: audit,
      sendResult: vi.fn(),
      sendFallbackResult,
      sendToolResult: vi.fn(),
    });

    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled(); // never signal indeterminate
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    expect(String((sendFallbackResult.mock.calls[0][3] as { content: string }).content)).toContain('Manual intervention required');
    expect(await mockFs.exists(`tasks/queues/results/${VALID_TASK_ID}/result.txt.manual-intervention`)).toBe(true);
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);

    const recovered = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recovered.some((e) => e.some((c) => c === 'reason=migrated_manual_intervention'))).toBe(true);

    // A second recovery pass must not re-notify (file moved out of running/).
    await recoverTasks({
      fs: mockFs,
      auditWriter: audit,
      sendResult: vi.fn(),
      sendFallbackResult,
      sendToolResult: vi.fn(),
    });
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
  });

  it('aggregates migrated manual-intervention fallback while preserving its artifact and terminal marker', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(unknownObservation('leader_gone_group_alive'));
    const task = makeV1MigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    const writeInboxAsync = vi.fn().mockResolvedValue(undefined);

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit, writeInboxAsync });

    expect(writeInboxAsync).toHaveBeenCalledTimes(1);
    const notice = JSON.parse(writeInboxAsync.mock.calls[0][2].content);
    expect(notice).toMatchObject({ aggregated: true, partial: false });
    expect(notice.items[0]).toMatchObject({
      fullTaskId: VALID_TASK_ID,
      is_error: true,
      reason: 'migrated_manual_intervention',
    });
    expect(JSON.parse(await mockFs.read(notice.items[0].resultRef)).result.content).toContain('Manual intervention required');
    expect(await mockFs.exists(`tasks/queues/results/${VALID_TASK_ID}/result.txt.manual-intervention`)).toBe(true);
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);
  });

  it('gone probe falls through to result delivery without signalling', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(goneObservation());

    const sendToolResult = vi.fn().mockResolvedValue(undefined);
    const task = makeV1MigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const exitMarkerPath = `tasks/queues/results/${VALID_TASK_ID}/exit.json`;
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    await mockFs.writeAtomic(resultPath, 'complete output');
    await mockFs.writeAtomic(exitMarkerPath, JSON.stringify({ completedAt: new Date().toISOString() }));

    const { audit } = makeMockAudit();
    await recoverTasks({
      fs: mockFs,
      auditWriter: audit,
      sendResult: vi.fn(),
      sendFallbackResult: vi.fn(),
      sendToolResult,
    });

    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();
    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect(sendToolResult.mock.calls[0][3]).toBe('complete output');
    expect(await mockFs.exists(`tasks/queues/done/${VALID_TASK_ID}.json`)).toBe(true);
  });

  it('verified group within deadline stays running without termination', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(aliveObservation());

    const task = makeV1MigratedTask({ migratedDeadlineMs: Date.now() + 3_600_000 });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();
    expect(mockFs.move).not.toHaveBeenCalled();
    const recovered = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recovered.length).toBe(1);
    expect(recovered[0]).toContain('reason=migrated_process_still_alive');
  });

  it('still_alive termination outcome keeps task in running without delivery', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(aliveObservation());
    mocks.terminateExecutionTarget.mockResolvedValue({
      status: 'still_alive',
      identity: { leaderPid: LEADER_PID, processGroupId: LEADER_PID },
      trigger: 'caller_requested',
      termSent: true,
      killSent: true,
      checkedAt: new Date().toISOString(),
      evidence: EVIDENCE,
    });

    const sendToolResult = vi.fn().mockResolvedValue(undefined);
    const task = makeV1MigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    await mockFs.writeAtomic(resultPath, 'partial output');

    const { audit, events } = makeMockAudit();
    await recoverTasks({
      fs: mockFs,
      auditWriter: audit,
      sendResult: vi.fn(),
      sendFallbackResult: vi.fn(),
      sendToolResult,
    });

    expect(mocks.terminateExecutionTarget).toHaveBeenCalledTimes(1);
    expect(sendToolResult).not.toHaveBeenCalled();
    expect(mockFs.move).not.toHaveBeenCalled();

    const termEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_MIGRATED_EXEC_TERMINATION);
    expect(termEvents.length).toBe(1);
    expect(termEvents[0]).toContain('status=still_alive');
    expect(termEvents[0]).toContain('kill_sent=true');
  });

  it('aggregates migrated dead-no-result fallback without creating a fake process result.txt', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(goneObservation());
    const task = makeV1MigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    const writeInboxAsync = vi.fn().mockResolvedValue(undefined);

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit, writeInboxAsync });

    const notice = JSON.parse(writeInboxAsync.mock.calls[0][2].content);
    expect(notice.items[0]).toMatchObject({
      fullTaskId: VALID_TASK_ID,
      reason: 'migrated_process_dead_no_result',
    });
    expect(notice.items[0].resultRef.endsWith('/recovery-fallback.json')).toBe(true);
    expect(await mockFs.exists(`tasks/queues/results/${VALID_TASK_ID}/result.txt`)).toBe(false);
    expect(await mockFs.exists(`tasks/queues/results/${VALID_TASK_ID}/result.txt.manual`)).toBe(true);
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(true);
  });

  it('dead-no-result fallback followed by move failure re-notifies only once (marker guard)', async () => {
    const mocks = await importProcessExecMocks();
    mocks.observeExecutionTarget.mockReturnValue(goneObservation());

    const sendFallbackResult = vi.fn().mockResolvedValue(undefined);
    const task = makeV1MigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    mockFs.move = vi.fn().mockRejectedValue(new Error('move failed'));

    const { audit } = makeMockAudit();
    const deps = { fs: mockFs, auditWriter: audit, sendResult: vi.fn(), sendFallbackResult, sendToolResult: vi.fn() };
    await recoverTasks(deps);
    await recoverTasks(deps);

    // Two recovery passes, both move attempts fail — the notification is
    // delivered exactly once thanks to the fallback marker.
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    expect(await mockFs.exists(`tasks/queues/results/${VALID_TASK_ID}/result.txt.manual`)).toBe(true);
  });

  // ATS keeps malformed identity artifacts opaque; ProcessExec rejects them
  // during decode and recovery remains observable without signalling.
  it('identity with PGID !== leader PID stays recoverable and is never observed or signalled', async () => {
    const mocks = await importProcessExecMocks();

    const task = makeV1MigratedTask({ migratedDeadlineMs: Date.now() + 3_600_000 });
    (task.migratedExecution as { processGroupId: number }).processGroupId = LEADER_PID + 1;
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);

    const { audit, events } = makeMockAudit();
    await recoverTasks(makeRecoverDeps(mockFs, audit));

    expect(mocks.observeExecutionTarget).not.toHaveBeenCalled();
    expect(mocks.terminateExecutionTarget).not.toHaveBeenCalled();

    const failures = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
    expect(failures.some(e => e.includes('context=migrated_exec_probe_indeterminate'))).toBe(true);
    expect(failures.some(e => e.some(col => typeof col === 'string' && col.startsWith('evidence=')))).toBe(true);
    expect(events.some(e => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT)).toBe(false);
    expect(await mockFs.exists(taskFile)).toBe(true);
    expect(await mockFs.exists(`tasks/queues/done/${VALID_TASK_ID}.json`)).toBe(false);
    expect(await mockFs.exists(`tasks/queues/failed/${VALID_TASK_ID}.json`)).toBe(false);
  });
});
