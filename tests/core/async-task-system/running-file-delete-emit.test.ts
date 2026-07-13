/**
 * Phase 884: tool not found in registry must NOT delete the running file.
 * Instead it should persist terminalState=failed and attempt to move to failed/.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { deriveShortIdFromTaskId } from '../../../src/core/async-task-system/types.js';
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

function makeToolTaskJson(taskId: string): string {
  return JSON.stringify({
    kind: 'tool',
    id: taskId,
    toolName: 'nonexistent_tool',
    args: {},
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 0,
    retryCount: 0,
  });
}

describe('phase 884: tool not found keeps running file', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      delete: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('tasks/queues/running/') || filePath.includes('tasks/queues/pending/')) {
          const id = filePath.replace(/^.*\//, '').replace(/\.json$/, '');
          return Promise.resolve(makeToolTaskJson(id));
        }
        return Promise.resolve('');
      }),
      move: vi.fn().mockResolvedValue(undefined),
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

  it('persists terminalState=failed and moves to failed dir instead of deleting', async () => {
    const taskId = 'tool-missing-move-ok';
    const runningPath = `tasks/queues/running/${taskId}.json`;
    const failedPath = `tasks/queues/failed/${taskId}.json`;

    await (system as any)._startTask(
      {
        kind: 'tool',
        id: taskId,
        toolName: 'nonexistent_tool',
        args: {},
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        parentClawDir: '/tmp',
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
        isIdempotent: true,
        maxRetries: 0,
        retryCount: 0,
      },
      new AbortController().signal,
    );

    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"failed"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, failedPath);

    const invariantEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.INVARIANT_VIOLATION && e.some(
        c => typeof c === 'string' && c.includes('kind=tool_not_found_registry'),
      ),
    );
    expect(invariantEvents.length).toBe(1);
    expect(invariantEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.INVARIANT_VIOLATION,
        expect.stringContaining('toolName=nonexistent_tool'),
      ]),
    );
  });

  it('move failure keeps running file and emits MOVE_FAILED audit', async () => {
    const taskId = 'tool-missing-move-fail';
    const runningPath = `tasks/queues/running/${taskId}.json`;
    const failedPath = `tasks/queues/failed/${taskId}.json`;
    (mockFs as any).move = vi.fn().mockImplementation((from: string, to: string) => {
      if (to.includes('tasks/queues/failed/')) {
        return Promise.reject(new Error('disk full'));
      }
      return Promise.resolve(undefined);
    });

    await (system as any)._startTask(
      {
        kind: 'tool',
        id: taskId,
        toolName: 'nonexistent_tool',
        args: {},
        // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
        parentClawDir: '/tmp',
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
        isIdempotent: true,
        maxRetries: 0,
        retryCount: 0,
      },
      new AbortController().signal,
    );

    expect((mockFs as any).delete).not.toHaveBeenCalled();

    const terminalStateWrites = (mockFs as any).writeAtomic.mock.calls.filter(
      ([filePath, content]: [string, string]) =>
        filePath === runningPath && content.includes('"terminalState":"failed"'),
    );
    expect(terminalStateWrites.length).toBe(1);

    expect((mockFs as any).move).toHaveBeenCalledWith(runningPath, failedPath);

    const moveFailedEvents = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.MOVE_FAILED && e.some(
        c => typeof c === 'string' && c.includes('context=tool_not_found_move_to_failed'),
      ),
    );
    expect(moveFailedEvents.length).toBe(1);
    expect(moveFailedEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.MOVE_FAILED,
        expect.stringContaining('fullTaskId='),
        expect.stringContaining('shortTaskId='),
        expect.stringContaining('context=tool_not_found_move_to_failed'),
        expect.stringContaining('error='),
      ]),
    );

    const fullTaskIdCol = moveFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('fullTaskId='),
    );
    expect(fullTaskIdCol).toContain(taskId);
    const shortTaskIdCol = moveFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('shortTaskId='),
    );
    expect(shortTaskIdCol).toContain(deriveShortIdFromTaskId(taskId as any));
    const errorCol = moveFailedEvents[0].find(
      (c): c is string => typeof c === 'string' && c.startsWith('error='),
    );
    expect(errorCol).toContain('disk full');
  });
});
