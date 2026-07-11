/**
 * Phase 881: cancel error propagation + schedule index audit + non-idempotent
 * recovery notification + inline fallback sent-marker ordering.
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
  it('rejects and audits when shortIdIndex add/save fails after file write', async () => {
    const { audit, events } = makeMockAudit();
    const shortIdIndex = new InMemoryShortIdIndex();
    vi.spyOn(shortIdIndex, 'add').mockImplementation(() => {
      throw new Error('index persist failed');
    });

    const mockFs: FileSystem = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      existsSync: vi.fn().mockReturnValue(false),
      listSync: vi.fn().mockReturnValue([]),
      exists: vi.fn().mockResolvedValue(false),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
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
    ).rejects.toThrow('index persist failed');

    const indexFailedEvents = events.filter(
      e => e[0] === TASK_AUDIT_EVENTS.SHORT_ID_INDEX_LOAD_FAILED && e.some(c => typeof c === 'string' && c.includes('context=schedule_index_write')),
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
