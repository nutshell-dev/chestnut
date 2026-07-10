import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
  sendFallbackError: vi.fn().mockRejectedValue(new Error('fallback fail')),
  sendToolResult: vi.fn().mockResolvedValue(undefined),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

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

function makeValidTask() {
  return {
    kind: 'subagent' as const,
    mode: 'standard' as const,
    id: '550e8400-e29b-41d4-a716-446655440000',
    shortId: '550e8400',
    intent: 'test',
    timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  };
}

function makeMockFsForPhase872(opts: {
  runningFiles?: Array<{ name: string; path: string; content: string }>;
  moveShouldFail?: boolean;
} = {}): FileSystem {
  const running = opts.runningFiles ?? [];
  const fileMap = new Map<string, string>();

  for (const f of running) fileMap.set(f.path, f.content);

  return {
    list: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'tasks/queues/running') {
        return Promise.resolve(running.map((f) => ({ name: f.name, path: f.path })));
      }
      if (dir === 'tasks/queues/pending') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    read: vi.fn().mockImplementation((filePath: string) => {
      const content = fileMap.get(filePath);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      if (opts.moveShouldFail) {
        return Promise.reject(new Error('disk full'));
      }
      const content = fileMap.get(from);
      fileMap.delete(from);
      if (content !== undefined) {
        fileMap.set(to, content);
      }
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((filePath: string) => {
      fileMap.delete(filePath);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((filePath: string, content: string) => {
      fileMap.set(filePath, content);
      return Promise.resolve(undefined);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation((filePath: string) => {
      return Promise.resolve(fileMap.has(filePath));
    }),
  } as unknown as FileSystem;
}

describe('phase 872: recovery keeps running file + intended-failed marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovery keeps running file when move to done fails', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      moveShouldFail: true,
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // running file must be preserved for next recovery retry
    expect(await mockFs.exists(taskFile)).toBe(true);

    // delete must NOT be called as a fallback
    expect(mockFs.delete).not.toHaveBeenCalledWith(taskFile);

    // recovery failure must be audited
    const moveFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=alreadysent_move_failed',
    );
    expect(moveFailedEvents.length).toBe(1);
  });

  it('recovery routes to failed when intended-failed marker exists', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';
    const intendedFailedMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.intended-failed';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(sentMarker, '1');
    await mockFs.writeAtomic(intendedFailedMarker, '');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // task should end up in failed/, not done/
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    // recovered event reason should reflect intended-failed routing
    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERED,
        expect.stringContaining('reason=intended_failed'),
      ]),
    );
  });

  it('recovery routes to done when no intended-failed marker', async () => {
    const task = makeValidTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/550e8400-e29b-41d4-a716-446655440000/result.txt.sent';

    const mockFs = makeMockFsForPhase872({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    await mockFs.writeAtomic(sentMarker, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    // task should end up in done/
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);
    expect(await mockFs.exists('tasks/queues/failed/550e8400-e29b-41d4-a716-446655440000.json')).toBe(false);

    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERED,
        expect.stringContaining('reason=already_sent'),
      ]),
    );
  });
});
