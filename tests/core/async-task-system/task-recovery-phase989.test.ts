import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
  sendFallbackError: vi.fn().mockRejectedValue(new Error('fallback fail')),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

function makeMockAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit: AuditLog = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
  };
  return { audit, events };
}

function makeValidTask(kind: 'subagent' | 'tool' = 'subagent') {
  return {
    kind,
    id: 'task-1',
    intent: 'test',
    timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  };
}

function makeMockFsForPhase989(opts: {
  runningFiles?: Array<{ name: string; path: string; content: string }>;
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

describe('phase 989 task-recovery sub-fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats corrupt retry counter as dead-letter promotion (phase 989 C.2)', async () => {
    const task = makeValidTask('subagent');
    const taskFile = 'tasks/queues/running/task-1.json';
    const retryPath = 'tasks/queues/results/task-1/result.txt.retry-count';
    const resultPath = 'tasks/queues/results/task-1/result.txt';

    const mockFs = makeMockFsForPhase989({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    // Pre-seed files so recovery takes the _recoverWithResult path
    await mockFs.writeAtomic(resultPath, 'result-content');
    await mockFs.writeAtomic(retryPath, 'abc');

    const { audit, events } = makeMockAudit();
    const pendingQueue: Array<unknown> = [];

    await recoverTasks({ fs: mockFs, auditWriter: audit, pendingQueue } as RecoverTasksDeps);

    // Verify: audit emitted retry_counter_corrupt
    const corruptEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=retry_counter_corrupt',
    );
    expect(corruptEvents.length).toBe(1);
    expect(corruptEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.RECOVERY_FAILED,
        expect.stringContaining('taskId='),
        'context=retry_counter_corrupt',
        expect.stringContaining('raw=abc'),
      ]),
    );

    // Verify: task moved to failed/ (dead-letter promotion)
    expect(await mockFs.exists('tasks/queues/failed/task-1.json')).toBe(true);
  });

  it('_recoverAlreadySent deletes retryPath after move (phase 989 C.3)', async () => {
    const task = makeValidTask('subagent');
    const taskFile = 'tasks/queues/running/task-1.json';
    const sentMarker = 'tasks/queues/results/task-1/result.txt.sent';
    const retryPath = 'tasks/queues/results/task-1/result.txt.retry-count';

    const mockFs = makeMockFsForPhase989({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    // Pre-seed sentMarker (triggers alreadySent path) and retryPath (leftover)
    await mockFs.writeAtomic(sentMarker, '1');
    await mockFs.writeAtomic(retryPath, '2');

    const { audit, events } = makeMockAudit();
    const pendingQueue: Array<unknown> = [];

    await recoverTasks({ fs: mockFs, auditWriter: audit, pendingQueue } as RecoverTasksDeps);

    // Verify: task moved to done/
    expect(await mockFs.exists('tasks/queues/done/task-1.json')).toBe(true);

    // Verify: retryPath deleted (C.3 fix)
    expect(await mockFs.exists(retryPath)).toBe(false);
  });
});
