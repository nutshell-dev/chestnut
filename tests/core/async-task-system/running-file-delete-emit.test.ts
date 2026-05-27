/**
 * Phase 1324 C.3: async-task running file delete fail → audit emit
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

describe('phase 1324 C.3: running file delete fail audit emit', () => {
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

  it('tool not found + fs.delete throw → RUNNING_FILE_DELETE_FAILED audit emitted with task_id + reason', async () => {
    const taskId = 'tool-missing-task';
    const deleteError = new Error('disk full');

    // Mock fs.delete to reject
    mockFs.delete = vi.fn().mockRejectedValue(deleteError);
    mockFs.read = vi.fn().mockResolvedValue(JSON.stringify({
      kind: 'tool',
      id: taskId,
      toolName: 'nonexistent_tool',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    }));
    mockFs.move = vi.fn().mockResolvedValue(undefined);
    mockFs.writeAtomic = vi.fn().mockResolvedValue(undefined);
    mockFs.ensureDir = vi.fn().mockResolvedValue(undefined);

    // _startTask catches tool-not-found internally and does not re-throw
    await (system as any)._startTask({
      kind: 'tool',
      id: taskId,
      toolName: 'nonexistent_tool',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    }, new AbortController().signal);

    const deleteFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RUNNING_FILE_DELETE_FAILED,
    );
    expect(deleteFailedEvents.length).toBe(1);
    expect(deleteFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RUNNING_FILE_DELETE_FAILED,
        expect.stringContaining('task_id='),
        expect.stringContaining('reason='),
      ]),
    );
    const taskIdCol = deleteFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('task_id='),
    );
    expect(taskIdCol).toContain(taskId);
    const reasonCol = deleteFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('reason='),
    );
    expect(reasonCol).toContain('disk full');
  });

  it('tool not found + fs.delete success → 0 RUNNING_FILE_DELETE_FAILED', async () => {
    const taskId = 'tool-missing-delete-ok';

    mockFs.delete = vi.fn().mockResolvedValue(undefined);
    mockFs.read = vi.fn().mockResolvedValue(JSON.stringify({
      kind: 'tool',
      id: taskId,
      toolName: 'nonexistent_tool',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    }));
    mockFs.move = vi.fn().mockResolvedValue(undefined);
    mockFs.writeAtomic = vi.fn().mockResolvedValue(undefined);
    mockFs.ensureDir = vi.fn().mockResolvedValue(undefined);

    await (system as any)._startTask({
      kind: 'tool',
      id: taskId,
      toolName: 'nonexistent_tool',
      args: {},
      parentClawDir: '/tmp',
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
      isIdempotent: true,
      maxRetries: 0,
      retryCount: 0,
    }, new AbortController().signal);

    const deleteFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.RUNNING_FILE_DELETE_FAILED,
    );
    expect(deleteFailedEvents.length).toBe(0);
  });
});
