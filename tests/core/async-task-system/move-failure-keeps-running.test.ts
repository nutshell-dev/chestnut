/**
 * Phase 871: moveTaskToDone / moveTaskToFailed failure must keep the running file
 * so that startup recovery can retry the move using the result.txt.sent marker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeFullTaskId } from '../../../src/core/async-task-system/types.js';
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

describe('phase 871: move failure keeps running file', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      move: vi.fn().mockRejectedValue(new Error('disk full')),
      delete: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.startsWith('tasks/queues/running/')) {
          return Promise.resolve(JSON.stringify({ id: 'task', kind: 'subagent' }));
        }
        return Promise.resolve('');
      }),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  afterEach(async () => {
    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('moveTaskToDone failure does not delete the running file and persists terminalState=done', async () => {
    const fullId = makeFullTaskId('550e8400-e29b-41d4-a716-446655440000');
    const runningPath = `tasks/queues/running/${fullId}.json`;
    const donePath = `tasks/queues/done/${fullId}.json`;

    await (system as any).moveTaskToDone(fullId);

    // terminalState=done must be persisted before the move attempt
    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"done"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, donePath);
    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED,
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.MOVE_FAILED,
        expect.stringContaining('context=move_to_done'),
      ]),
    );
  });

  it('moveTaskToFailed failure does not delete the running file and persists terminalState=failed', async () => {
    const fullId = makeFullTaskId('660e8400-e29b-41d4-a716-446655440000');
    const runningPath = `tasks/queues/running/${fullId}.json`;
    const failedPath = `tasks/queues/failed/${fullId}.json`;

    await (system as any).moveTaskToFailed(fullId);

    // terminalState=failed must be persisted before the move attempt
    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"failed"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, failedPath);
    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED,
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.MOVE_FAILED,
        expect.stringContaining('context=move_to_failed'),
      ]),
    );
  });
});
