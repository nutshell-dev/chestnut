/**
 * Phase 883:
 * 1. schedule() add/save split: add failure throws, save failure emits TASK_SCHEDULED with indexPersisted=false
 * 2. non-idempotent tool recovery writes notified marker and skips re-notification on restart
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

vi.mock('../../../src/core/async-task-system/result-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/async-task-system/result-delivery.js')>();
  return {
    ...actual,
    sendFallbackError: vi.fn().mockResolvedValue(undefined),
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

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex,
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
    await system.initialize();

    await expect(
      system.schedule('subagent', {
        parentClawId: 'claw-1',
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
