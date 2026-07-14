/**
 * Merged: dispatch resilience invariants.
 * Sources:
 * - phase883.test.ts
 * - phase884.test.ts
 * - phase885.test.ts
 * - phase905.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { recoverTasks } from '../../../src/core/async-task-system/task-recovery.js';
import { sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ToolTask } from '../../../src/core/async-task-system/types.js';
import type { WatcherFactory } from '../../../src/foundation/file-watcher/index.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/async-task-system/result-delivery.js')>();
  return {
    ...actual,
    sendFallbackError: vi.fn().mockResolvedValue(undefined),
  };
});

/**
 * Phase 883:
 * 1. schedule() add/save split: add failure throws, save failure emits TASK_SCHEDULED with indexPersisted=false
 * 2. non-idempotent tool recovery writes notified marker and skips re-notification on restart
 */
describe('phase883.test.ts', () => {
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

  describe('phase 883: schedule index save failure emits TASK_SCHEDULED with indexPersisted=false', () => {
    let system: AsyncTaskSystem;

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('returns shortId and emits TASK_SCHEDULED with indexPersisted=false when save fails', async () => {
      const { audit, events } = makeMockAudit();
      const shortIdIndex = new InMemoryShortIdIndex();

      const files = new Map<string, string>();
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        existsSync: vi.fn().mockReturnValue(false),
        listSync: vi.fn().mockReturnValue([]),
        exists: vi.fn().mockImplementation((path: string) => Promise.resolve(files.has(path))),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          files.set(path, content);
          return Promise.resolve(undefined);
        }),
      } as unknown as FileSystem;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex,
        auditWriter: audit,
        ...makeTaskSystemDeps(),
      });
      await system.initialize();

      // Spy on save AFTER initialize so startup migration can persist the index.
      vi.spyOn(shortIdIndex, 'save').mockImplementation(() => {
        throw new Error('index save failed');
      });

      const shortId = await system.schedule('subagent', {
        parentClawId: 'claw-1',
        parentClawDir: '/tmp/claw',
        goal: 'test goal',
        maxSteps: 10,
      } as any);

      // Must return a valid shortId instead of rejecting.
      expect(typeof shortId).toBe('string');
      expect(shortId.length).toBe(8);

      // TASK_SCHEDULED must be emitted with indexPersisted=false.
      const scheduledEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
      expect(scheduledEvents.length).toBe(1);
      expect(scheduledEvents[0]).toContain('indexPersisted=false');

      // Index save failure must be audited.
      const indexFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED && e.some(c => typeof c === 'string' && c.includes('context=schedule_index_save')),
      );
      expect(indexFailedEvents.length).toBe(1);
    });
  });

  describe('phase 883: schedule add collision throws', () => {
    let system: AsyncTaskSystem;

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('throws when shortIdIndex.add fails (collision)', async () => {
      const { audit } = makeMockAudit();
      const shortIdIndex = new InMemoryShortIdIndex();
      vi.spyOn(shortIdIndex, 'add').mockImplementation(() => {
        throw new Error('ShortId collision');
      });

      const files = new Map<string, string>();
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        existsSync: vi.fn().mockReturnValue(false),
        listSync: vi.fn().mockReturnValue([]),
        exists: vi.fn().mockImplementation((path: string) => Promise.resolve(files.has(path))),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          files.set(path, content);
          return Promise.resolve(undefined);
        }),
      } as unknown as FileSystem;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex,
        auditWriter: audit,
        ...makeTaskSystemDeps(),
      });
      await system.initialize();

      await expect(
        system.schedule('subagent', {
          parentClawId: 'claw-1',
          parentClawDir: '/tmp/claw',
          goal: 'test goal',
          maxSteps: 10,
        } as any),
      ).rejects.toThrow('ShortId collision');
    });
  });

  describe('phase 883: non-idempotent tool recovery notified marker', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('skips notification when notified marker already exists', async () => {
      const task: ToolTask = {
        kind: 'tool',
        id: '550e8400-e29b-41d4-a716-446655440003',
        shortId: '550e8403',
        toolName: 'read',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 2,
        retryCount: 0,
      };
      const taskFile = 'tasks/queues/running/550e8400-e29b-41d4-a716-446655440003.json';
      const notifiedPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440003/result.txt.notified';
      const fileMap = new Map<string, string>([
        [taskFile, JSON.stringify(task)],
        [notifiedPath, ''],
      ]);

      const { audit, events } = makeMockAudit();
      const mockFs: FileSystem = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') return Promise.resolve([{ name: '550e8400-e29b-41d4-a716-446655440003.json', path: taskFile }]);
          if (dir === 'tasks/queues/pending') return Promise.resolve([]);
          if (dir === 'tasks/queues/failed') return Promise.resolve([]);
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          const content = fileMap.get(path);
          if (content === undefined) return Promise.reject(new Error('ENOENT'));
          return Promise.resolve(content);
        }),
        move: vi.fn().mockImplementation((from: string, to: string) => {
          const content = fileMap.get(from);
          fileMap.delete(from);
          if (content !== undefined) fileMap.set(to, content);
          return Promise.resolve(undefined);
        }),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          fileMap.set(path, content);
          return Promise.resolve(undefined);
        }),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => Promise.resolve(fileMap.has(path))),
      } as unknown as FileSystem;

      await recoverTasks({ fs: mockFs, auditWriter: audit });

      // sendFallbackError must NOT be called because marker exists.
      expect(sendFallbackError).not.toHaveBeenCalled();

      // Task must be moved to failed directory.
      const failedPath = 'tasks/queues/failed/550e8400-e29b-41d4-a716-446655440003.json';
      expect(await mockFs.exists(failedPath)).toBe(true);
      expect(await mockFs.exists(taskFile)).toBe(false);

      // Recovery must be audited with already_notified reason.
      const recoveredEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
      expect(recoveredEvents.length).toBe(1);
      expect(recoveredEvents[0]).toContain('reason=non_idempotent_already_notified');
    });
  });
});

/**
 * Phase 884: startDispatch contract + dispatch loop resilience
 */
describe('phase 884: startDispatch + dispatch loop resilience', () => {
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

  function makeMockWatcherFactory(): WatcherFactory {
    return vi.fn((_path, _callback, _opts) => ({
      close: vi.fn().mockResolvedValue(undefined),
      isActive: () => true,
      getPath: () => _path,
    }));
  }

  function makeBaseMockFs(): FileSystem {
    return {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockResolvedValue(''),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;
  }

  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = makeBaseMockFs();
    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      createWatcher: makeMockWatcherFactory(),
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('startDispatch rejects when watcher initial scan fails', async () => {
    const scanError = new Error('pending dir unreadable');
    mockFs.list = vi.fn().mockRejectedValue(scanError);

    await expect(system.startDispatch()).rejects.toThrow(scanError);

    const recoveryFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
        c => typeof c === 'string' && c.includes('context=initial_scan_pending_failed'),
      ),
    );
    expect(recoveryFailedEvents.length).toBe(1);
    expect(recoveryFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        expect.stringContaining('source=system'),
        expect.stringContaining('context=initial_scan_pending_failed'),
        expect.stringContaining('error='),
      ]),
    );
  });

  it('startDispatch is idempotent', async () => {
    const loopSpy = vi.spyOn(system as any, '_runDispatchLoop');

    await system.startDispatch();
    await system.startDispatch();

    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatch loop retries after _getPendingTasks failure and audits the error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await system.initialize();
    await system.startDispatch();

    let calls = 0;
    (system as any)._getPendingTasks = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new Error('transient listing failure');
      }
      return [];
    });

    await vi.waitFor(
      () => auditEvents.some(
        e => e[0] === TASK_AUDIT_EVENTS.INVARIANT_VIOLATION && e.some(
          c => typeof c === 'string' && c.includes('kind=dispatch_loop_error'),
        ),
      ),
      { timeout: 5000 },
    );

    await vi.advanceTimersByTimeAsync(1100);

    await vi.waitFor(() => calls >= 2, { timeout: 5000 });
    expect(calls).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });
});

/**
 * Phase 885:
 * 1. notification marker write/read failures stop recovery and keep task in running
 * 2. schedule() add() failure moves the orphaned pending file to failed
 * 3. startDispatch() deduplicates concurrent calls and cleans up on watcher start failure
 */
describe('phase885.test.ts', () => {
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

  function makeBaseMockWatcherFactory(): WatcherFactory {
    return vi.fn((_path, _callback, _opts) => ({
      close: vi.fn().mockResolvedValue(undefined),
      isActive: () => true,
      getPath: () => _path,
    }));
  }

  function makeBaseMockFs(): FileSystem {
    return {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockResolvedValue(''),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;
  }

  describe('phase 885: marker write/read failure handling', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('keeps task in running when notification marker write fails', async () => {
      const task: ToolTask = {
        kind: 'tool',
        id: '550e8400-e29b-41d4-a716-446655440003',
        shortId: '550e8403',
        toolName: 'read',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 2,
        retryCount: 0,
      };
      const taskFile = 'tasks/queues/running/550e8400-e29b-41d4-a716-446655440003.json';
      const notifiedPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440003/result.txt.notified';
      const failedPath = 'tasks/queues/failed/550e8400-e29b-41d4-a716-446655440003.json';
      const fileMap = new Map<string, string>([[taskFile, JSON.stringify(task)]]);

      const { audit, events } = makeMockAudit();
      const mockFs: FileSystem = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') return Promise.resolve([{ name: '550e8400-e29b-41d4-a716-446655440003.json', path: taskFile }]);
          if (dir === 'tasks/queues/pending') return Promise.resolve([]);
          if (dir === 'tasks/queues/failed') return Promise.resolve([]);
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          const content = fileMap.get(path);
          if (content === undefined) return Promise.reject(new Error('ENOENT'));
          return Promise.resolve(content);
        }),
        move: vi.fn().mockImplementation((from: string, to: string) => {
          const content = fileMap.get(from);
          fileMap.delete(from);
          if (content !== undefined) fileMap.set(to, content);
          return Promise.resolve(undefined);
        }),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          if (path === notifiedPath) {
            return Promise.reject(new Error('EIO while writing marker'));
          }
          fileMap.set(path, content);
          return Promise.resolve(undefined);
        }),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => Promise.resolve(fileMap.has(path))),
      } as unknown as FileSystem;

      await recoverTasks({ fs: mockFs, auditWriter: audit });

      expect(sendFallbackError).toHaveBeenCalledTimes(1);
      expect(fileMap.has(taskFile)).toBe(true);
      expect(fileMap.has(failedPath)).toBe(false);

      const markerFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
          c => typeof c === 'string' && c.includes('context=non_idempotent_marker_write_failed'),
        ),
      );
      expect(markerFailedEvents.length).toBe(1);
    });

    it('stops recovery when notification marker read fails with IO error', async () => {
      const task: ToolTask = {
        kind: 'tool',
        id: '550e8400-e29b-41d4-a716-446655440003',
        shortId: '550e8403',
        toolName: 'read',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 2,
        retryCount: 0,
      };
      const taskFile = 'tasks/queues/running/550e8400-e29b-41d4-a716-446655440003.json';
      const notifiedPath = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440003/result.txt.notified';
      const failedPath = 'tasks/queues/failed/550e8400-e29b-41d4-a716-446655440003.json';
      const fileMap = new Map<string, string>([[taskFile, JSON.stringify(task)]]);

      const { audit, events } = makeMockAudit();
      const mockFs: FileSystem = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') return Promise.resolve([{ name: '550e8400-e29b-41d4-a716-446655440003.json', path: taskFile }]);
          if (dir === 'tasks/queues/pending') return Promise.resolve([]);
          if (dir === 'tasks/queues/failed') return Promise.resolve([]);
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          const content = fileMap.get(path);
          if (content === undefined) return Promise.reject(new Error('ENOENT'));
          return Promise.resolve(content);
        }),
        move: vi.fn().mockImplementation((from: string, to: string) => {
          const content = fileMap.get(from);
          fileMap.delete(from);
          if (content !== undefined) fileMap.set(to, content);
          return Promise.resolve(undefined);
        }),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          fileMap.set(path, content);
          return Promise.resolve(undefined);
        }),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => {
          if (path === notifiedPath) return Promise.reject(new Error('EIO while reading marker'));
          return Promise.resolve(fileMap.has(path));
        }),
      } as unknown as FileSystem;

      await recoverTasks({ fs: mockFs, auditWriter: audit });

      expect(sendFallbackError).not.toHaveBeenCalled();
      expect(fileMap.has(taskFile)).toBe(true);
      expect(fileMap.has(failedPath)).toBe(false);

      const markerReadFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
          c => typeof c === 'string' && c.includes('context=non_idempotent_marker_read_failed'),
        ),
      );
      expect(markerReadFailedEvents.length).toBe(1);
    });
  });

  describe('phase 885: schedule add collision compensation', () => {
    let system: AsyncTaskSystem;

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('moves orphaned pending file to failed when add() throws', async () => {
      const { audit, events } = makeMockAudit();
      const shortIdIndex = new InMemoryShortIdIndex();
      vi.spyOn(shortIdIndex, 'add').mockImplementation(() => {
        throw new Error('ShortId collision');
      });

      const files = new Map<string, string>();
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        existsSync: vi.fn().mockReturnValue(false),
        listSync: vi.fn().mockReturnValue([]),
        exists: vi.fn().mockImplementation((path: string) => Promise.resolve(files.has(path))),
        move: vi.fn().mockImplementation((from: string, to: string) => {
          const content = files.get(from);
          files.delete(from);
          if (content !== undefined) files.set(to, content);
          return Promise.resolve(undefined);
        }),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          files.set(path, content);
          return Promise.resolve(undefined);
        }),
      } as unknown as FileSystem;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex,
        auditWriter: audit,
        createWatcher: makeBaseMockWatcherFactory(),
        ...makeTaskSystemDeps(),
      });
      await system.initialize();

      await expect(
        system.schedule('subagent', {
          parentClawId: 'claw-1',
          parentClawDir: '/tmp/claw',
          goal: 'test goal',
          maxSteps: 10,
        } as any),
      ).rejects.toThrow('ShortId collision');

      // Pending file must have been removed and moved to failed.
      const pendingPaths = Array.from(files.keys()).filter(p => p.startsWith('tasks/queues/pending/'));
      const failedPaths = Array.from(files.keys()).filter(p => p.startsWith('tasks/queues/failed/'));
      expect(pendingPaths.length).toBe(0);
      expect(failedPaths.length).toBe(1);

      // INVARIANT_VIOLATION audit must record the collision site.
      const invariantEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.INVARIANT_VIOLATION && e.some(
          c => typeof c === 'string' && c.includes('site=schedule_add_collision'),
        ),
      );
      expect(invariantEvents.length).toBe(1);
    });
  });

  describe('phase 885: startDispatch concurrency and cleanup', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(() => {
      mockFs = makeBaseMockFs();
      const { audit, events } = makeMockAudit();
      auditEvents = events;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex: new InMemoryShortIdIndex(),
        auditWriter: audit,
        createWatcher: makeBaseMockWatcherFactory(),
        ...makeTaskSystemDeps(),
      });
    });

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('deduplicates concurrent startDispatch calls', async () => {
      const loopSpy = vi.spyOn(system as any, '_runDispatchLoop');

      const [p1, p2] = [system.startDispatch(), system.startDispatch()];
      await Promise.all([p1, p2]);

      expect(loopSpy).toHaveBeenCalledTimes(1);
      expect(system['pendingWatcherHandle']).toBeDefined();
    });

    it('cleans up watcher on start failure and allows retry', async () => {
      const startError = new Error('watcher start failed');
      const failingStart = vi.fn().mockRejectedValue(startError);
      const failingClose = vi.fn().mockResolvedValue(undefined);
      system['pendingWatcherHandle'] = {
        start: failingStart,
        close: failingClose,
      } as any;

      await expect(system.startDispatch()).rejects.toThrow(startError);
      expect(failingClose).toHaveBeenCalledTimes(1);
      expect(system['pendingWatcherHandle']).toBeUndefined();
      expect((system as any)._dispatchRunning).toBe(false);

      // A subsequent startDispatch should see a clean state and succeed.
      const okStart = vi.fn().mockResolvedValue(undefined);
      const okClose = vi.fn().mockResolvedValue(undefined);
      system['pendingWatcherHandle'] = {
        start: okStart,
        close: okClose,
      } as any;

      await system.startDispatch();
      expect(okStart).toHaveBeenCalledTimes(1);
      expect((system as any)._dispatchRunning).toBe(true);
    });
  });
});

/**
 * Phase 905:
 * 1. shutdown close 容错 — watcher close 失败时仍执行 abort
 * 2. shutdown drain 超时后不清除未 settle 任务
 * 3. cancel pending subagent 任务也通知 parent
 */
describe('phase905.test.ts', () => {
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

  function makeBaseMockFs(): FileSystem {
    return {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockResolvedValue(''),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;
  }

  function makeBaseMockWatcherFactory(): WatcherFactory {
    return vi.fn((_path, _callback, _opts) => ({
      close: vi.fn().mockResolvedValue(undefined),
      isActive: () => true,
      getPath: () => _path,
    }));
  }

  describe('phase 905: shutdown close fault tolerance', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(() => {
      mockFs = makeBaseMockFs();
      const { audit, events } = makeMockAudit();
      auditEvents = events;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex: new InMemoryShortIdIndex(),
        auditWriter: audit,
        createWatcher: makeBaseMockWatcherFactory(),
        ...makeTaskSystemDeps(),
      });
    });

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('aborts tasks even when watcher close fails', async () => {
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');

      const executingTasks = (system as any).executingTasks as Map<string, { abortController: AbortController; promise: Promise<void> }>;
      executingTasks.set('task-905-1', {
        abortController,
        promise: new Promise(() => { /* never resolves */ }),
      });

      const closeError = new Error('watcher close exploded');
      (system as any).pendingWatcherHandle = {
        close: vi.fn().mockRejectedValue(closeError),
      };

      await system.shutdown(1);

      expect(abortSpy).toHaveBeenCalled();

      const watcherCloseFailedEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT && e.some(c => typeof c === 'string' && c.includes('context=watcher_close_failed')),
      );
      expect(watcherCloseFailedEvents.length).toBe(1);
      expect(watcherCloseFailedEvents[0].some(c => typeof c === 'string' && c.includes('watcher close exploded'))).toBe(true);
    });
  });

  describe('phase 905: shutdown drain keeps unsettled tasks', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(() => {
      mockFs = makeBaseMockFs();
      const { audit, events } = makeMockAudit();
      auditEvents = events;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex: new InMemoryShortIdIndex(),
        auditWriter: audit,
        createWatcher: makeBaseMockWatcherFactory(),
        ...makeTaskSystemDeps(),
      });
    });

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('does not clear unsettled tasks after drain timeout', async () => {
      const taskId = 'task-905-2';
      const abortController = new AbortController();

      const executingTasks = (system as any).executingTasks as Map<string, { abortController: AbortController; promise: Promise<void> }>;
      executingTasks.set(taskId, {
        abortController,
        promise: new Promise(() => { /* never resolves */ }),
      });

      await system.shutdown(1);

      expect(executingTasks.has(taskId)).toBe(true);

      const shutdownTimeoutEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.SHUTDOWN_TIMEOUT,
      );
      expect(shutdownTimeoutEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('phase 905: cancel pending subagent notifies parent', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(() => {
      vi.clearAllMocks();
      mockFs = makeBaseMockFs();
      const { audit, events } = makeMockAudit();
      auditEvents = events;

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        shortIdIndex: new InMemoryShortIdIndex(),
        auditWriter: audit,
        createWatcher: makeBaseMockWatcherFactory(),
        ...makeTaskSystemDeps(),
      });
    });

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('sends fallback error for cancelled pending subagent task', async () => {
      const fullId = '550e8400-e29b-41d4-a716-446655440905';
      const shortId = fullId.slice(0, 8);
      const pendingPath = `tasks/queues/pending/${fullId}.json`;

      // Register shortId so cancel() can resolve it.
      const shortIdIndex = (system as any).shortIdIndex as { add: (shortId: string, fullId: string) => void };
      shortIdIndex.add(shortId, fullId);

      const task = {
        id: fullId,
        shortId,
        kind: 'subagent',
        mode: 'standard',
        intent: 'test intent',
        timeoutMs: 60000,
        parentClawId: 'parent-claw',
        parentClawDir: '/tmp/claw',
        createdAt: new Date().toISOString(),
      };

      mockFs.read = vi.fn().mockImplementation((p: string) => {
        if (p === pendingPath) return Promise.resolve(JSON.stringify(task));
        return Promise.resolve('');
      });
      mockFs.exists = vi.fn().mockImplementation((p: string) => {
        if (p === pendingPath) return Promise.resolve(true);
        return Promise.resolve(false);
      });
      mockFs.move = vi.fn().mockResolvedValue(undefined);

      await system.initialize();
      await system.cancel(shortId);

      expect(sendFallbackError).toHaveBeenCalledTimes(1);
      const calledTask = (sendFallbackError as any).mock.calls[0][2];
      expect(calledTask.id).toBe(fullId);
      expect(calledTask.kind).toBe('subagent');

      const cancelledEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c === `fullTaskId=${fullId}`),
      );
      expect(cancelledEvents.length).toBe(1);
    });
  });
});

