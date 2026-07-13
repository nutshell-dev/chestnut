/**
 * Phase 882:
 * 1. sent marker write failure preserves resultRef for retry
 * 2. schedule() index write failure returns shortId instead of rejecting
 * 3. non-idempotent tool recovery keeps task in running when notification fails
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { recoverTasks } from '../../../src/core/async-task-system/task-recovery.js';
import { sendResult } from '../../../src/core/async-task-system/result-delivery.js';
import { writeInboxAsync } from '../../../src/foundation/messaging/index.js';
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

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
