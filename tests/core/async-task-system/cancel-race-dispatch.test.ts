/**
 * Phase 1011 D.3: task cancel move ENOENT race lost to dispatch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeMockFsForCancelRace(): FileSystem {
  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    resolve: vi.fn((p: string) => `/abs/${p}`),
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
    };
    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(100).catch(() => {});
  });

  it('cancel pending move ENOENT emits TASK_CANCEL_RACE_LOST_TO_DISPATCH', async () => {
    await system.initialize();

    await system.cancel('task-X');

    const raceLostEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH && e.some(c => typeof c === 'string' && c === 'taskId=task-X'),
    );
    expect(raceLostEvents.length).toBe(1);

    // should NOT emit MOVE_FAILED for ENOENT
    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cancel_pending_move')),
    );
    expect(moveFailedEvents.length).toBe(0);
  });
});
