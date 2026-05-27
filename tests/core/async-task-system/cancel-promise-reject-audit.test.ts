/**
 * Phase 859: cancel path promise reject audit (Sa.2)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('phase 859 r111 H fork: cancel path promise reject audit (Sa.2)', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(100).catch(() => {});
  });

  // 反向 1（关键路径 reject → audit emit）
  it('cancel running task whose promise rejects → CANCEL_PROMISE_REJECTED audit emitted with error= payload', async () => {
    const taskId = 'task-reject-on-cancel';
    const abortController = new AbortController();
    const rejectError = new Error('abort-cleanup-explosion');

    const promise = Promise.reject(rejectError);
    // Prevent unhandled rejection crash in test runner
    promise.catch(() => {});

    (system as any).runningTasks.set(taskId, {
      abortController,
      promise,
    });

    await system.cancel(taskId);

    const cancelPromiseRejectedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
    );
    expect(cancelPromiseRejectedEvents.length).toBe(1);
    expect(cancelPromiseRejectedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
        expect.stringContaining('taskId='),
        expect.stringContaining('error='),
      ]),
    );
    // error= payload contains the raw error message
    const errorCol = cancelPromiseRejectedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('error='),
    );
    expect(errorCol).toContain('abort-cleanup-explosion');

    // CANCELLED still emitted after CANCEL_PROMISE_REJECTED
    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED,
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCELLED,
        expect.stringContaining('taskId='),
        'from=running',
      ]),
    );
  });

  // 反向 3（边界路径反向）：task promise resolves cleanly → 0 CANCEL_PROMISE_REJECTED + CANCELLED 仍发
  it('cancel running task whose promise resolves cleanly → no CANCEL_PROMISE_REJECTED + CANCELLED only', async () => {
    const taskId = 'task-resolve-on-cancel';
    const abortController = new AbortController();

    const promise = Promise.resolve();

    (system as any).runningTasks.set(taskId, {
      abortController,
      promise,
    });

    await system.cancel(taskId);

    const cancelPromiseRejectedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCEL_PROMISE_REJECTED,
    );
    expect(cancelPromiseRejectedEvents.length).toBe(0);

    const cancelledEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.CANCELLED,
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.CANCELLED,
        expect.stringContaining('taskId='),
        'from=running',
      ]),
    );
  });
});
