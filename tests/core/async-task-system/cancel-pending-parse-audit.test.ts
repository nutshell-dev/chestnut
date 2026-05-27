/**
 * Phase 1013 E.4: cancel pending parse fail audit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
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
  };
  return { audit, events };
}

describe('phase 1013 E.4: cancel pending parse fail audit', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue('this is not valid json'),
      move: vi.fn().mockResolvedValue(undefined),
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

  it('cancel pending task with corrupted JSON file → PARSE_FAILED audit emitted', async () => {
    const taskId = 'task-parse-fail';

    await system.cancel(taskId);

    const parseFailedEvents = auditEvents.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.PARSE_FAILED,
    );
    expect(parseFailedEvents.length).toBe(1);
    expect(parseFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.PARSE_FAILED,
        expect.stringContaining('taskId='),
        'context=cancel_pending_load',
        expect.stringContaining('error='),
      ]),
    );
  });
});
