/**
 * Phase 1011 D.3: task cancel move ENOENT race lost to dispatch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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

describe('phase 1011 D.3: cancel race lost to dispatch', () => {
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

    await system.cancel('task-X');

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
