/**
 * Phase 1790 Step B: cancel typed outcome (AT-D1 治理)。
 *
 * - `cancelDetailed()` exhaustive 返回 CancelOutcome；pending 通知失败返回
 *   `pending_notification_failure`（taskId/path/原始 error），pending 文件保留可重试，
 *   不压成 cancelled；`cancel_notify_failed` audit 保留。
 * - `cancel()` 兼容包装只做明确投影：legacy throw（race lost / not found）与
 *   void（cancelled / notification failure）语义逐路径保留。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import type { CancelOutcome } from '../../../src/core/async-task-system/index.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { WatcherFactory, WatchEvent } from '../../../src/foundation/file-watcher/index.js';
import {
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_FAILED_DIR,
} from '../../../src/core/async-task-system/dirs.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/async-task-system/result-delivery.js')>();
  return {
    ...actual,
    sendFallbackResult: vi.fn().mockResolvedValue(undefined),
  };
});

import { sendFallbackResult } from '../../../src/core/async-task-system/result-delivery.js';

const FULL_ID = '550e8400-e29b-41d4-a716-446655441790';
const SHORT_ID = FULL_ID.slice(0, 8);

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
    for (const [p] of fileMap) {
      const lastSlash = p.lastIndexOf('/');
      const fileDir = lastSlash >= 0 ? p.slice(0, lastSlash) : p;
      if (fileDir === dir) entries.push({ name: p.slice(lastSlash + 1), path: p });
    }
    listMap.set(dir, entries);
  };

  for (const p of Object.keys(seed)) {
    const lastSlash = p.lastIndexOf('/');
    if (lastSlash >= 0) updateList(p.slice(0, lastSlash));
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
      updateList(p.slice(0, p.lastIndexOf('/')));
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((p: string, content: string) => {
      fileMap.set(p, content);
      updateList(p.slice(0, p.lastIndexOf('/')));
      return Promise.resolve(undefined);
    }),
  } as unknown as FileSystem;
}

function makeMockWatcherFactory(): { createWatcher: WatcherFactory } {
  const createWatcher: WatcherFactory = (_path, _callback: (event: WatchEvent) => void) => ({
    close: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockReturnValue(true),
    getPath: vi.fn().mockReturnValue(_path),
  });
  return { createWatcher };
}

function makePendingTask(): Record<string, unknown> {
  return {
    id: FULL_ID,
    shortId: SHORT_ID,
    kind: 'subagent',
    mode: 'standard',
    intent: 'test intent',
    timeoutMs: 60000,
    parentClawId: 'parent-claw',
    parentClawDir: '/tmp/claw',
    createdAt: new Date().toISOString(),
  };
}

describe('phase 1790: cancelDetailed typed CancelOutcome', () => {
  let system: AsyncTaskSystem;
  let fs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;
  const pendingPath = `${TASKS_QUEUES_PENDING_DIR}/${FULL_ID}.json`;

  beforeEach(() => {
    const { audit, events } = makeMockAudit();
    auditEvents = events;
    fs = makeInMemoryFs();
    system = new AsyncTaskSystem('/tmp/claw', fs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
      createWatcher: makeMockWatcherFactory().createWatcher,
    });
    const shortIdIndex = (system as any).shortIdIndex as { add: (shortId: string, fullId: string) => void };
    shortIdIndex.add(SHORT_ID, FULL_ID);
    vi.mocked(sendFallbackResult).mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  async function seedPending(): Promise<void> {
    await fs.writeAtomic(pendingPath, JSON.stringify(makePendingTask()));
    await system.initialize();
  }

  it('pending_notification_failure: pending 保留不移动、携带 taskId/path/原始 error，audit 保留', async () => {
    const boom = new Error('notify failed EIO');
    vi.mocked(sendFallbackResult).mockRejectedValue(boom);
    await seedPending();

    const outcome = await system.cancelDetailed(SHORT_ID);

    expect(outcome).toEqual({
      kind: 'pending_notification_failure',
      taskId: FULL_ID,
      path: pendingPath,
      error: 'notify failed EIO',
    } satisfies CancelOutcome);
    // pending 文件保留（不移动）→ 可重试
    expect(fs.move).not.toHaveBeenCalled();
    expect(await fs.exists(pendingPath)).toBe(true);
    expect(sendFallbackResult).toHaveBeenCalledTimes(1);
    // 不压成 cancelled
    expect(auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.CANCELLED)).toHaveLength(0);
    // cancel_notify_failed audit 保留
    expect(auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('cancel_notify_failed')),
    )).toHaveLength(1);
  });

  it('重试可见性：通知恢复后再次 cancelDetailed → cancelled(from=pending) 且移入 failed/', async () => {
    vi.mocked(sendFallbackResult).mockRejectedValueOnce(new Error('transient notify failure'));
    await seedPending();

    const first = await system.cancelDetailed(SHORT_ID);
    expect(first.kind).toBe('pending_notification_failure');

    const second = await system.cancelDetailed(SHORT_ID);
    expect(second).toEqual({ kind: 'cancelled', from: 'pending' } satisfies CancelOutcome);
    expect(await fs.exists(pendingPath)).toBe(false);
    expect(await fs.exists(`${TASKS_QUEUES_FAILED_DIR}/${FULL_ID}.json`)).toBe(true);
    expect(auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.CANCELLED)).toHaveLength(1);
  });

  it('not_found: running/pending 均无 → typed not_found（INVARIANT_VIOLATION audit 保留）', async () => {
    await system.initialize();

    const outcome = await system.cancelDetailed(SHORT_ID);

    expect(outcome).toEqual({ kind: 'not_found', taskId: SHORT_ID } satisfies CancelOutcome);
    expect(auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.INVARIANT_VIOLATION && e.some(c => typeof c === 'string' && c.includes('task_not_found')),
    )).toHaveLength(1);
  });

  it('cancel() 兼容投影：notification failure → void（legacy），不 throw', async () => {
    vi.mocked(sendFallbackResult).mockRejectedValue(new Error('notify failed'));
    await seedPending();

    await expect(system.cancel(SHORT_ID)).resolves.toBeUndefined();
    // pending 保留（投影不吞状态，仅投影返回值）
    expect(await fs.exists(pendingPath)).toBe(true);
  });

  it('cancel() 兼容投影：not_found → legacy INVARIANT VIOLATION throw', async () => {
    await system.initialize();

    await expect(system.cancel(SHORT_ID)).rejects.toThrow('[INVARIANT VIOLATION]');
  });

  it('cancelDetailed 成功路径：cancelled(from=pending) + CANCELLED audit', async () => {
    await seedPending();

    const outcome = await system.cancelDetailed(SHORT_ID);

    expect(outcome).toEqual({ kind: 'cancelled', from: 'pending' } satisfies CancelOutcome);
    expect(auditEvents.filter(e => e[0] === TASK_AUDIT_EVENTS.CANCELLED)).toHaveLength(1);
    expect(await fs.exists(`${TASKS_QUEUES_FAILED_DIR}/${FULL_ID}.json`)).toBe(true);
  });
});
