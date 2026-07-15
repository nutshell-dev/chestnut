/**
 * Cancel invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - cancel-pending-move-failure.test.ts
 *  - cancel-pending-parse-audit.test.ts
 *  - cancel-race-dispatch.test.ts
 *  - cancel-promise-reject-audit.test.ts
 *  - cancel-pending-corrupt.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { WatcherFactory, WatchEvent } from '../../../src/foundation/file-watcher/index.js';

function makeMockWatcherFactory(): { createWatcher: WatcherFactory; getCallback: () => ((event: WatchEvent) => void) | undefined } {
  let capturedWatcherCallback: ((event: WatchEvent) => void) | undefined;
  const createWatcher: WatcherFactory = (_path, callback) => {
    capturedWatcherCallback = callback;
    return {
      close: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(true),
      getPath: vi.fn().mockReturnValue(_path),
    };
  };
  return { createWatcher, getCallback: () => capturedWatcherCallback };
}

const mockWatcherFactory = makeMockWatcherFactory();

/**
 * Phase 878: cancel pending move non-ENOENT failure must not emit CANCELLED.
 */

describe('phase 878: cancel pending move non-ENOENT failure', () => {
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

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    const { audit, events } = makeMockAudit();
    auditEvents = events;

    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      existsSync: vi.fn().mockReturnValue(false),
      listSync: vi.fn().mockReturnValue([]),
      exists: vi.fn().mockImplementation((path: string) => {
        if (path.includes('tasks/queues/pending/task-X.json')) return Promise.resolve(true);
        return Promise.resolve(false);
      }),
      move: vi.fn().mockImplementation((from: string) => {
        if (from.includes('tasks/queues/pending/task-X.json')) {
          const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return Promise.reject(err);
        }
        return Promise.resolve();
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      createWatcher: mockWatcherFactory.createWatcher,
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not emit CANCELLED when cancel move fails with non-ENOENT error', async () => {
    await system.initialize();

    await expect(system.cancel('task-X')).rejects.toThrow('Cancel failed');

    // MOVE_FAILED audit must be emitted for the actual move failure
    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cancel_pending_move')),
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('error='),
      ]),
    );

    // No race-lost event: ENOENT is the race-lost signal, not EACCES
    const raceLostEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH && e.some(c => typeof c === 'string' && c === 'fullTaskId=task-X'),
    );
    expect(raceLostEvents.length).toBe(0);

    // CANCELLED must NOT be emitted: the task is still pending and will execute
    const cancelledEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c.includes('fullTaskId=task-X')),
    );
    expect(cancelledEvents.length).toBe(0);
  });
});

/**
 * Phase 1013 E.4: cancel pending parse fail audit
 */

describe('phase 1013 E.4: cancel pending parse fail audit', () => {
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

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue('this is not valid json'),
      move: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      createWatcher: mockWatcherFactory.createWatcher,
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('cancel pending task with corrupted JSON file → PARSE_FAILED audit emitted', async () => {
    const taskId = 'task-parse-fail';

    await system.cancel(taskId);

    const parseFailedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.PARSE_FAILED,
    );
    expect(parseFailedEvents.length).toBe(1);
    expect(parseFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.PARSE_FAILED,
        expect.stringContaining('fullTaskId='),
        expect.stringContaining('shortTaskId='),
        'context=cancel_pending_load',
        expect.stringContaining('error='),
      ]),
    );
  });
});

/**
 * Phase 1011 D.3: task cancel move ENOENT race lost to dispatch
 */

describe('phase 1011 D.3: cancel race lost to dispatch', () => {
  function makeMockFsForCancelRace(): FileSystem {
    return {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      existsSync: vi.fn().mockReturnValue(false),
      listSync: vi.fn().mockReturnValue([]),
      exists: vi.fn().mockImplementation((path: string) => {
        if (path.includes('tasks/queues/pending/task-X.json')) return Promise.resolve(true);
        return Promise.resolve(false);
      }),
      move: vi.fn().mockImplementation((from: string) => {
        if (from.includes('tasks/queues/pending/task-X.json')) {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return Promise.reject(err);
        }
        return Promise.resolve();
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;
  }

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

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = makeMockFsForCancelRace();
    auditEvents = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEvents.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      createWatcher: mockWatcherFactory.createWatcher,
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('cancel pending move ENOENT emits TASK_CANCEL_RACE_LOST_TO_DISPATCH and aborts running task', async () => {
    await system.initialize();

    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, 'abort');
    const state = { abortController, promise: Promise.resolve() };

    // Race simulation: the first executingTasks lookup (running check) must miss,
    // but the second lookup inside the ENOENT race-lost path must find the task.
    const executingTasks = (system as any).executingTasks as Map<string, unknown>;
    let getCount = 0;
    executingTasks.get = function (key: string) {
      if (key === 'task-X') {
        getCount++;
        if (getCount > 1) return state;
      }
      return Map.prototype.get.call(this, key);
    };

    await expect(system.cancel('task-X')).rejects.toThrow('Cancel race lost');

    const raceLostEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH && e.some(c => typeof c === 'string' && (c === 'fullTaskId=task-X' || c === 'shortTaskId=task-X')),
    );
    expect(raceLostEvents.length).toBe(1);

    // should NOT emit MOVE_FAILED for ENOENT
    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cancel_pending_move')),
    );
    expect(moveFailedEvents.length).toBe(0);

    // should abort the running task
    expect(abortSpy).toHaveBeenCalled();

    // should NOT emit CANCELLED because the race was lost, not successfully cancelled
    const cancelledEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c.includes('fullTaskId=task-X')),
    );
    expect(cancelledEvents.length).toBe(0);
  });
});

/**
 * Phase 859: cancel path promise reject audit (Sa.2)
 */

describe('phase 859 r111 H fork: cancel path promise reject audit (Sa.2)', () => {
  // ─── Helpers ─────────────────────────────────────────────────────────────────

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

  // ─── Tests ───────────────────────────────────────────────────────────────────

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      createWatcher: mockWatcherFactory.createWatcher,
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  // 反向 1（关键路径 reject → audit emit）
  it('cancel running task whose promise rejects → CANCEL_PROMISE_REJECTED audit emitted with error= payload', async () => {
    const taskId = 'task-reject-on-cancel';
    const abortController = new AbortController();
    const rejectError = new Error('abort-cleanup-explosion');

    const promise = Promise.reject(rejectError);
    // Prevent unhandled rejection crash in test runner
    promise.catch(() => { /* silent: cleanup */ });

    (system as any).executingTasks.set(taskId, {
      abortController,
      promise,
    });

    await system.cancel(taskId);

    const cancelPromiseRejectedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
    );
    expect(cancelPromiseRejectedEvents.length).toBe(1);
    expect(cancelPromiseRejectedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
        expect.stringContaining('fullTaskId='),
        expect.stringContaining('shortTaskId='),
        expect.stringContaining('error='),
      ]),
    );
    // error= payload contains the raw error message
    const errorCol = cancelPromiseRejectedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('error='),
    );
    expect(errorCol).toContain('abort-cleanup-explosion');

    // CANCELLED still emitted after CANCEL_PROMISE_REJECTED
    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED,
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCELLED,
        expect.stringContaining('fullTaskId='),
        expect.stringContaining('shortTaskId='),
        'from=running',
      ]),
    );
  });

  // 反向 3（边界路径反向）：task promise resolves cleanly → 0 CANCEL_PROMISE_REJECTED + CANCELLED 仍发
  it('cancel running task whose promise resolves cleanly → no CANCEL_PROMISE_REJECTED + CANCELLED only', async () => {
    const taskId = 'task-resolve-on-cancel';
    const abortController = new AbortController();

    const promise = Promise.resolve();

    (system as any).executingTasks.set(taskId, {
      abortController,
      promise,
    });

    await system.cancel(taskId);

    const cancelPromiseRejectedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
    );
    expect(cancelPromiseRejectedEvents.length).toBe(0);

    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED,
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCELLED,
        expect.stringContaining('fullTaskId='),
        expect.stringContaining('shortTaskId='),
        'from=running',
      ]),
    );
  });
});

describe('cancel pending task with corrupt JSON triggers backupCorruptTask audit (phase 1012)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('corrupt JSON parse fail → backupCorruptTask audit TASK_CORRUPT + CANCELLED from pending_corrupt, no move to failed', async () => {
    const auditEvents: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEvents.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };

    const mockFs: FileSystem = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-bad.json') {
          return Promise.resolve('not valid json');
        }
        return Promise.resolve('');
      }),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-bad.json') {
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      }),
    } as unknown as FileSystem;

    const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });

    await system.cancel('task-bad');

    // corrupt input → TASK_CORRUPT audit emitted
    const corruptEvents = auditEvents.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
    expect(corruptEvents.length).toBe(1);
    expect(corruptEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.TASK_CORRUPT,
        expect.stringContaining('backup='),
        expect.stringContaining('move_ok=true'),
        expect.stringContaining('error='),
      ]),
    );

    // Phase 887: corrupt file is quarantined by backupCorruptTask; cancel emits
    // CANCELLED from=pending_corrupt and does NOT attempt to move to failed.
    expect(mockFs.move).toHaveBeenCalledWith(
      'tasks/queues/pending/task-bad.json',
      expect.stringMatching(/tasks\/queues\/pending\/task-bad\.json\.corrupt-\d+/),
    );
    expect(mockFs.move).not.toHaveBeenCalledWith(
      'tasks/queues/pending/task-bad.json',
      'tasks/queues/failed/task-bad.json',
    );

    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some((c) => typeof c === 'string' && c.includes('from=pending_corrupt')),
    );
    expect(cancelledEvents.length).toBe(1);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('valid JSON but shape mismatch → backupCorruptTask audit + CANCELLED from pending_corrupt, no move to failed', async () => {
    const auditEvents: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEvents.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };

    const mockFs: FileSystem = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-shape.json') {
          return Promise.resolve(JSON.stringify({ id: 'x', kind: 'bogus' }));
        }
        return Promise.resolve('');
      }),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-shape.json') {
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      }),
    } as unknown as FileSystem;

    const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });

    await system.cancel('task-shape');

    const corruptEvents = auditEvents.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
    expect(corruptEvents.length).toBe(1);
    expect(corruptEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.TASK_CORRUPT,
        expect.stringContaining('error=shape_mismatch'),
      ]),
    );

    // Phase 887: corrupt file is quarantined by backupCorruptTask; cancel emits
    // CANCELLED from=pending_corrupt and does NOT attempt to move to failed.
    expect(mockFs.move).toHaveBeenCalledWith(
      'tasks/queues/pending/task-shape.json',
      expect.stringMatching(/tasks\/queues\/pending\/task-shape\.json\.corrupt-\d+/),
    );
    expect(mockFs.move).not.toHaveBeenCalledWith(
      'tasks/queues/pending/task-shape.json',
      'tasks/queues/failed/task-shape.json',
    );

    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some((c) => typeof c === 'string' && c.includes('from=pending_corrupt')),
    );
    expect(cancelledEvents.length).toBe(1);

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });
});
