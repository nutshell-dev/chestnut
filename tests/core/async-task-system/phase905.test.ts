/**
 * Phase 905:
 * 1. shutdown close 容错 — watcher close 失败时仍执行 abort
 * 2. shutdown drain 超时后不清除未 settle 任务
 * 3. cancel pending subagent 任务也通知 parent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { WatcherFactory } from '../../../src/foundation/file-watcher/index.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/async-task-system/result-delivery.js')>();
  return {
    ...actual,
    sendFallbackError: vi.fn().mockResolvedValue(undefined),
  };
});

import { sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';

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

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
