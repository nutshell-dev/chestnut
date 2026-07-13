/**
 * Phase 878: cancel pending move non-ENOENT failure must not emit CANCELLED.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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

describe('phase 878: cancel pending move non-ENOENT failure', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    const { audit, events } = makeMockAudit();
    auditEvents = events;

    mockFs = {
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
          const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return Promise.reject(err);
        }
        return Promise.resolve();
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('does not emit CANCELLED when cancel move fails with non-ENOENT error', async () => {
    await system.initialize();

    await expect(system.cancel('task-X')).rejects.toThrow('Cancel failed');

    // MOVE_FAILED audit must be emitted for the actual move failure
    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(c => typeof c === 'string' && c.includes('context=cancel_pending_move')),
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('error='),
      ]),
    );

    // No race-lost event: ENOENT is the race-lost signal, not EACCES
    const raceLostEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.TASK_CANCEL_RACE_LOST_TO_DISPATCH && e.some(c => typeof c === 'string' && c === 'fullTaskId=task-X'),
    );
    expect(raceLostEvents.length).toBe(0);

    // CANCELLED must NOT be emitted: the task is still pending and will execute
    const cancelledEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.CANCELLED && e.some(c => typeof c === 'string' && c.includes('fullTaskId=task-X')),
    );
    expect(cancelledEvents.length).toBe(0);
  });
});
