/**
 * Phase 906:
 * 1. dispatcher runtime convergence for migrated tasks past deadline
 * 2. SIGKILL verification — keep in running if process survives
 * 3. cancel notification moved before terminal state commit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { WatcherFactory } from '../../../src/foundation/file-watcher/index.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from '../../../src/core/async-task-system/dirs.js';

vi.mock('../../../src/core/async-task-system/task-recovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/async-task-system/task-recovery.js')>();
  return {
    ...actual,
    recoverMigratedToolTask: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('../../../src/core/async-task-system/result-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/async-task-system/result-delivery.js')>();
  return {
    ...actual,
    sendFallbackError: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn(),
    getProcessStartTime: vi.fn(),
  };
});

import { recoverMigratedToolTask } from '../../../src/core/async-task-system/task-recovery.js';
import { sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';
import { isAlive, getProcessStartTime } from '../../../src/foundation/process-exec/index.js';
import { recoverTasks } from '../../../src/core/async-task-system/task-recovery.js';

const VALID_TASK_ID = '550e8400-e29b-41d4-a716-446655440906';
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

function makeInMemoryFs(seed: Record<string, string> = {}): FileSystem {
  const fileMap = new Map<string, string>(Object.entries(seed));
  const listMap = new Map<string, Array<{ name: string; path: string }>>();

  const updateList = (dir: string): void => {
    const entries: Array<{ name: string; path: string }> = [];
    for (const [path, _content] of fileMap) {
      const lastSlash = path.lastIndexOf('/');
      const fileDir = lastSlash >= 0 ? path.slice(0, lastSlash) : path;
      if (fileDir === dir) {
        const name = path.slice(lastSlash + 1);
        entries.push({ name, path });
      }
    }
    listMap.set(dir, entries);
  };

  for (const dir of Object.keys(seed)) {
    const lastSlash = dir.lastIndexOf('/');
    if (lastSlash >= 0) updateList(dir.slice(0, lastSlash));
  }

  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation((p: string) => Promise.resolve(fileMap.has(p))),
    list: vi.fn().mockImplementation((dir: string) => {
      updateList(dir);
      return Promise.resolve(listMap.get(dir) ?? []);
    }),
    resolve: vi.fn((p: string) => `/abs/${p}`),
    read: vi.fn().mockImplementation((p: string) => {
      const content = fileMap.get(p);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      const content = fileMap.get(from);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      fileMap.delete(from);
      fileMap.set(to, content);
      updateList(from.slice(0, from.lastIndexOf('/')));
      updateList(to.slice(0, to.lastIndexOf('/')));
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((p: string) => {
      fileMap.delete(p);
      const dir = p.slice(0, p.lastIndexOf('/'));
      updateList(dir);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((p: string, content: string) => {
      fileMap.set(p, content);
      const dir = p.slice(0, p.lastIndexOf('/'));
      updateList(dir);
      return Promise.resolve(undefined);
    }),
  } as unknown as FileSystem;
}

function makeBaseMockWatcherFactory(): WatcherFactory {
  return vi.fn((_path, _callback, _opts) => ({
    close: vi.fn().mockResolvedValue(undefined),
    isActive: () => true,
    getPath: () => _path,
  }));
}

function makeMigratedToolTask(opts: { migratedDeadlineMs?: number; migratedStartTime?: string } = {}) {
  return {
    kind: 'tool' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    toolName: 'exec',
    args: { command: 'sleep 9999' },
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    parentClawDir: '/tmp/claw',
    parentClawId: 'parent-claw',
    createdAt: '2020-01-01T00:00:00Z',
    isIdempotent: false,
    maxRetries: 0,
    retryCount: 0,
    mode: 'migrated' as const,
    migratedPid: 12345,
    migratedStartTime: opts.migratedStartTime ?? 'Mon Jan 01 00:00:00 2020',
    migratedDeadlineMs: opts.migratedDeadlineMs ?? 1,
  };
}

describe('phase 906: dispatcher runtime convergence for migrated deadlines', () => {
  let system: AsyncTaskSystem;
  let fs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    vi.clearAllMocks();
    fs = makeInMemoryFs();
    const { audit, events } = makeMockAudit();
    auditEvents = events;

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      createWatcher: makeBaseMockWatcherFactory(),
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('re-runs recovery for migrated task whose deadline has passed', async () => {
    const runningPath = `${TASKS_QUEUES_RUNNING_DIR}/${VALID_TASK_ID}.json`;
    const task = makeMigratedToolTask();

    // Initialize creates directories and runs cold-start recovery (running dir empty).
    await system.initialize();

    // Simulate a migrated task left in running after wrapper release.
    await fs.writeAtomic(runningPath, JSON.stringify(task));

    // Invoke the internal deadline checker directly.
    await (system as any)._checkMigratedDeadlines();

    expect(recoverMigratedToolTask).toHaveBeenCalledTimes(1);
    const [callDeps, callPath, callTask] = vi.mocked(recoverMigratedToolTask).mock.calls[0];
    expect(callPath).toBe(runningPath);
    expect((callTask as { id: string }).id).toBe(VALID_TASK_ID);
    expect(callDeps.fs).toBe(fs);
  });
});

describe('phase 906: SIGKILL verification keeps task in running', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps task in running and audits when SIGKILL does not terminate the process', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    // alive at entry, dies after SIGTERM wait, alive again at SIGKILL gate, survives SIGKILL verification
    vi.mocked(isAlive)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(true);

    const startTime = 'Mon Jan 01 00:00:00 2020';
    vi.mocked(getProcessStartTime).mockReturnValue(startTime);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const task = makeMigratedToolTask({ migratedStartTime: startTime });
    const runningPath = `${TASKS_QUEUES_RUNNING_DIR}/${VALID_TASK_ID}.json`;
    const fs = makeInMemoryFs({
      [runningPath]: JSON.stringify(task),
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs, auditWriter: audit } as Parameters<typeof recoverTasks>[0]);

    // Task must remain in running dir because SIGKILL was ineffective.
    expect(fs.move).not.toHaveBeenCalled();

    const sigkillEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=migrated_sigkill_ineffective',
    );
    expect(sigkillEvents.length).toBe(1);

    killSpy.mockRestore();
  });
});

describe('phase 906: cancel notification failure keeps task in pending', () => {
  let system: AsyncTaskSystem;
  let fs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    vi.clearAllMocks();
    fs = makeInMemoryFs();
    const { audit, events } = makeMockAudit();
    auditEvents = events;

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      createWatcher: makeBaseMockWatcherFactory(),
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('leaves pending task in place when sendFallbackError rejects', async () => {
    vi.mocked(sendFallbackError).mockRejectedValue(new Error('notify failed'));

    const fullId = '550e8400-e29b-41d4-a716-446655440906';
    const shortId = fullId.slice(0, 8);
    const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${fullId}.json`;

    const shortIdIndex = (system as any).shortIdIndex as { add: (shortId: string, fullId: string) => void };
    shortIdIndex.add(shortId, fullId);

    const task = {
      id: fullId,
      shortId,
      kind: 'subagent' as const,
      mode: 'standard' as const,
      intent: 'test intent',
      timeoutMs: 60000,
      parentClawId: 'parent-claw',
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      parentClawDir: '/tmp/claw',
      createdAt: new Date().toISOString(),
    };

    await fs.writeAtomic(pendingPath, JSON.stringify(task));

    await system.initialize();
    await system.cancel(shortId);

    // Notification attempted but failed.
    expect(sendFallbackError).toHaveBeenCalledTimes(1);

    // Pending file must NOT have been moved to failed.
    expect(fs.move).not.toHaveBeenCalled();

    // CANCELLED must NOT be emitted.
    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED,
    );
    expect(cancelledEvents.length).toBe(0);

    // Failure must be audited.
    const notifyFailedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some((c) => typeof c === 'string' && c.includes('cancel_notify_failed')),
    );
    expect(notifyFailedEvents.length).toBe(1);
  });
});
