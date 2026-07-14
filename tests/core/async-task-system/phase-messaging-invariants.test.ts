/**
 * Merged test file (mechanical consolidation, no assertion changes).
 * Sources (all shared the same messaging vi.mock — kept once at top):
 *  - phase879.test.ts
 *  - phase881.test.ts
 *  - phase882.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendToolResult, sendFallbackError, sendResult } from '../../../src/core/async-task-system/result-delivery.js';
import { executeToolTask } from '../../../src/core/async-task-system/tool-executor.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { recoverTasks } from '../../../src/core/async-task-system/task-recovery.js';
import { writeInboxAsync } from '../../../src/foundation/messaging/index.js';
import * as messaging from '../../../src/foundation/messaging/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { ToolTask } from '../../../src/core/async-task-system/types.js';

vi.mock('../../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    writeInboxAsync: vi.fn(),
  };
});

/**
 * Phase 879 — resultRef deletion ordering + isIdempotent guard + fallback dual IDs
 */

describe('phase879.test.ts', () => {
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
});

/**
 * Phase 881: cancel error propagation + schedule index audit + non-idempotent
 * recovery notification + inline fallback sent-marker ordering.
 */

describe('phase881.test.ts', () => {
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

  function makeMockFsForCancelMoveError(code: string): FileSystem {
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
          const err = Object.assign(new Error(code), { code });
          return Promise.reject(err);
        }
        return Promise.resolve();
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;
  }

  describe('phase 881: cancel error propagation', () => {
    let system: AsyncTaskSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('cancel rejects when pending→failed move fails with non-ENOENT', async () => {
      const { audit, events } = makeMockAudit();
      auditEvents = events;

      system = new AsyncTaskSystem('/tmp/claw', makeMockFsForCancelMoveError('EACCES'), {
        shortIdIndex: new InMemoryShortIdIndex(),
        auditWriter: audit,
        ...makeTaskSystemDeps(),
      });
      await system.initialize();

      await expect(system.cancel('task-X')).rejects.toThrow('Cancel failed: cannot move task task-X to failed');

      const moveFailedEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cancel_pending_move')),
      );
      expect(moveFailedEvents.length).toBe(1);

      const cancelledEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c.includes('fullTaskId=task-X')),
      );
      expect(cancelledEvents.length).toBe(0);
    });

    it('cancel rejects on dispatch race loss (ENOENT)', async () => {
      const { audit, events } = makeMockAudit();
      auditEvents = events;

      system = new AsyncTaskSystem('/tmp/claw', makeMockFsForCancelMoveError('ENOENT'), {
        shortIdIndex: new InMemoryShortIdIndex(),
        auditWriter: audit,
        ...makeTaskSystemDeps(),
      });
      await system.initialize();

      await expect(system.cancel('task-X')).rejects.toThrow('Cancel race lost: task task-X already dispatched to running');

      const raceLostEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH && e.some(c => typeof c === 'string' && c === 'fullTaskId=task-X'),
      );
      expect(raceLostEvents.length).toBe(1);

      const cancelledEvents = auditEvents.filter(
        e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c.includes('fullTaskId=task-X')),
      );
      expect(cancelledEvents.length).toBe(0);
    });
  });

  describe('phase 881: schedule index write audit', () => {
    it('returns shortId and emits TASK_SCHEDULED when shortIdIndex save fails after file write', async () => {
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

      const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
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

      expect(typeof shortId).toBe('string');
      expect(shortId.length).toBe(8);

      const scheduledEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
      expect(scheduledEvents.length).toBe(1);
      expect(scheduledEvents[0]).toContain('indexPersisted=false');

      const indexFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED && e.some(c => typeof c === 'string' && c.includes('context=schedule_index_save')),
      );
      expect(indexFailedEvents.length).toBe(1);

      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });
  });

  describe('phase 881: non-idempotent tool recovery notifies parent', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sends fallback error to parent after moving non-idempotent tool task to failed', async () => {
      const task: ToolTask = {
        kind: 'tool',
        id: '550e8400-e29b-41d4-a716-446655440001',
        shortId: '550e8401',
        toolName: 'read',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 2,
        retryCount: 0,
      };
      const taskFile = 'tasks/queues/running/550e8400-e29b-41d4-a716-446655440001.json';
      const fileMap = new Map<string, string>([[taskFile, JSON.stringify(task)]]);

      vi.mocked(writeInboxAsync).mockResolvedValue(undefined);

      const mockFs: FileSystem = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') return Promise.resolve([{ name: '550e8400-e29b-41d4-a716-446655440001.json', path: taskFile }]);
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

      const { audit } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit });

      const failedPath = 'tasks/queues/failed/550e8400-e29b-41d4-a716-446655440001.json';
      expect(await mockFs.exists(failedPath)).toBe(true);

      expect(writeInboxAsync).toHaveBeenCalled();
      const inboxCalls = vi.mocked(writeInboxAsync).mock.calls;
      const lastCall = inboxCalls[inboxCalls.length - 1];
      const message = lastCall[2] as { content: string };
      const parsed = JSON.parse(message.content);
      expect(parsed.is_error).toBe(true);
      expect(parsed.result).toContain('Non-idempotent tool task cannot be retried after crash');
    });
  });

  describe('phase 881: inline fallback sent-marker ordering', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('writes sent marker before deleting resultRef on inline fallback', async () => {
      let inboxCallCount = 0;
      vi.mocked(writeInboxAsync).mockImplementation(() => {
        inboxCallCount++;
        // First call (ref message) fails; second call (inline fallback) succeeds.
        if (inboxCallCount === 1) return Promise.reject(new Error('inbox write failed'));
        return Promise.resolve(undefined);
      });

      const operationLog: Array<{ op: string; path: string }> = [];
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockImplementation((path: string) => {
          operationLog.push({ op: 'delete', path });
          return Promise.resolve(undefined);
        }),
        writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
          operationLog.push({ op: 'writeAtomic', path });
          return Promise.resolve(undefined);
        }),
      } as unknown as FileSystem;

      const { audit } = makeMockAudit();
      const task = {
        id: 'task-881-inline',
        shortId: '881inline',
        kind: 'subagent' as const,
        mode: 'standard' as const,
        parentClawId: 'parent',
        intent: 'test',
        timeoutMs: 1000,
        maxSteps: 1,
        createdAt: new Date().toISOString(),
      };

      await sendResult(mockFs, audit, task, 'x'.repeat(2000), false);

      const markerIndex = operationLog.findIndex(o => o.op === 'writeAtomic' && o.path.endsWith('.sent'));
      const deleteIndex = operationLog.findIndex(o => o.op === 'delete' && o.path.endsWith('result.txt'));

      expect(markerIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThanOrEqual(0);
      expect(markerIndex).toBeLessThan(deleteIndex);
    });
  });
});

/**
 * Phase 882:
 * 1. sent marker write failure preserves resultRef for retry
 * 2. schedule() index write failure returns shortId instead of rejecting
 * 3. non-idempotent tool recovery keeps task in running when notification fails
 */

describe('phase882.test.ts', () => {
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

  describe('phase 882: sent marker write failure preserves resultRef', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('preserves resultRef when sent marker write fails on inline fallback', async () => {
      let inboxCallCount = 0;
      vi.mocked(writeInboxAsync).mockImplementation(() => {
        inboxCallCount++;
        // First call (ref message) fails; second call (inline fallback) succeeds.
        if (inboxCallCount === 1) return Promise.reject(new Error('inbox write failed'));
        return Promise.resolve(undefined);
      });

      const deletedPaths: string[] = [];
      const writtenPaths: string[] = [];
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockImplementation((path: string) => {
          deletedPaths.push(path);
          return Promise.resolve(undefined);
        }),
        writeAtomic: vi.fn().mockImplementation((path: string) => {
          writtenPaths.push(path);
          if (path.endsWith('.sent')) {
            return Promise.reject(new Error('marker write failed'));
          }
          return Promise.resolve(undefined);
        }),
      } as unknown as FileSystem;

      const { audit, events } = makeMockAudit();
      const task = {
        id: 'task-882-marker',
        shortId: '882mrk',
        kind: 'subagent' as const,
        mode: 'standard' as const,
        parentClawId: 'parent',
        intent: 'test',
        timeoutMs: 1000,
        maxSteps: 1,
        createdAt: new Date().toISOString(),
      };

      await sendResult(mockFs, audit, task, 'x'.repeat(2000), false);

      // Marker write failure should be audited.
      const markerFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.RESULT_WRITE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=sent_marker_persist_failed')),
      );
      expect(markerFailedEvents.length).toBe(1);

      // The orphan result.txt must NOT be deleted because the marker was not persisted.
      const resultTxtDeleted = deletedPaths.some(p => p.endsWith('result.txt'));
      expect(resultTxtDeleted).toBe(false);

      // Marker path should have been attempted.
      const markerWritten = writtenPaths.some(p => p.endsWith('.sent'));
      expect(markerWritten).toBe(true);
    });
  });

  describe('phase 882: schedule index save failure returns shortId', () => {
    let system: AsyncTaskSystem;

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('returns shortId and keeps task file when shortIdIndex save fails', async () => {
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

      // Task file must exist on disk.
      const taskFiles = Array.from(files.keys()).filter(p => p.startsWith('tasks/queues/pending/') && p.endsWith('.json'));
      expect(taskFiles.length).toBe(1);

      // TASK_SCHEDULED must be emitted with indexPersisted=false (Phase 883 refinement).
      const scheduledEvents = events.filter(e => e[0] === TASK_AUDIT_EVENTS.TASK_SCHEDULED);
      expect(scheduledEvents.length).toBe(1);
      expect(scheduledEvents[0]).toContain('indexPersisted=false');

      // Index failure must be audited.
      const indexFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED && e.some(c => typeof c === 'string' && c.includes('context=schedule_index_save')),
      );
      expect(indexFailedEvents.length).toBe(1);
    });
  });

  describe('phase 882: non-idempotent tool recovery keeps running on notify failure', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('keeps task in running when sendFallbackError fails', async () => {
      const task: ToolTask = {
        kind: 'tool',
        id: '550e8400-e29b-41d4-a716-446655440002',
        shortId: '550e8402',
        toolName: 'read',
        args: {},
        parentClawDir: '/tmp',
        parentClawId: 'parent-claw',
        createdAt: new Date().toISOString(),
        isIdempotent: false,
        maxRetries: 2,
        retryCount: 0,
      };
      const taskFile = 'tasks/queues/running/550e8400-e29b-41d4-a716-446655440002.json';
      const fileMap = new Map<string, string>([[taskFile, JSON.stringify(task)]]);

      // Simulate inbox notification failure.
      vi.mocked(writeInboxAsync).mockRejectedValue(new Error('inbox unreachable'));

      const { audit, events } = makeMockAudit();
      const mockFs: FileSystem = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') return Promise.resolve([{ name: '550e8400-e29b-41d4-a716-446655440002.json', path: taskFile }]);
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

      // Notification failure must be audited.
      const notifyFailedEvents = events.filter(
        e => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(c => typeof c === 'string' && c.includes('context=non_idempotent_notify_failed')),
      );
      expect(notifyFailedEvents.length).toBe(1);

      // Task must remain in running directory.
      expect(await mockFs.exists(taskFile)).toBe(true);

      // Task must NOT be moved to failed directory.
      const failedPath = 'tasks/queues/failed/550e8400-e29b-41d4-a716-446655440002.json';
      expect(await mockFs.exists(failedPath)).toBe(false);
    });
  });
});
