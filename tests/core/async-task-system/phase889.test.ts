/**
 * Phase 889:
 * 1. migrated tool recovery: exists/read I/O errors must not be treated as business state
 * 2. migrated tool recovery: SENT_MARKER makes re-delivery idempotent
 * 3. _recoverWithResult: non-ENOENT retry counter read failure stops recovery
 * 4. _recoverWithResult: retry counter write failure stops recovery
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { sendToolResult, sendResult, sendFallbackError, SENT_MARKER } from '../../../src/core/async-task-system/result-delivery.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockResolvedValue(undefined),
  sendFallbackError: vi.fn().mockResolvedValue(undefined),
  sendToolResult: vi.fn().mockResolvedValue(undefined),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

const VALID_TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_TASK_SHORT_ID = '550e8400';

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

function makeMigratedToolTask() {
  return {
    kind: 'tool' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    toolName: 'read',
    args: {},
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
    mode: 'migrated' as const,
    migratedPid: 12345,
    migratedStartTime: String(Date.now()),
  };
}

function makeSubAgentTask() {
  return {
    kind: 'subagent' as const,
    mode: 'standard' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    intent: 'test',
    timeoutMs: 1000,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  };
}

function makeMockFs(
  runningFiles: Array<{ name: string; path: string; content: string }>,
  overrides?: {
    exists?: (path: string, fileMap: Map<string, string>) => Promise<boolean> | boolean;
    read?: (path: string, fileMap: Map<string, string>) => Promise<string>;
    writeAtomic?: (path: string, content: string, fileMap: Map<string, string>) => Promise<void>;
  },
): FileSystem {
  const fileMap = new Map<string, string>();
  for (const f of runningFiles) fileMap.set(f.path, f.content);

  return {
    list: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'tasks/queues/running') {
        return Promise.resolve(runningFiles.map((f) => ({ name: f.name, path: f.path })));
      }
      if (dir === 'tasks/queues/pending') return Promise.resolve([]);
      if (dir === 'tasks/queues/failed') return Promise.resolve([]);
      return Promise.resolve([]);
    }),
    read: vi.fn().mockImplementation((path: string) => {
      if (overrides?.read) return overrides.read(path, fileMap);
      const content = fileMap.get(path);
      if (content === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(content);
    }),
    move: vi.fn().mockImplementation((from: string, to: string) => {
      const content = fileMap.get(from);
      fileMap.delete(from);
      if (content !== undefined) fileMap.set(to, content);
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation((path: string) => {
      fileMap.delete(path);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
      if (overrides?.writeAtomic) return overrides.writeAtomic(path, content, fileMap);
      fileMap.set(path, content);
      return Promise.resolve(undefined);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation((path: string) => {
      if (overrides?.exists) return overrides.exists(path, fileMap);
      return Promise.resolve(fileMap.has(path));
    }),
  } as unknown as FileSystem;
}

describe('phase 889: migrated tool recovery I/O error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps task in running when result exists() throws I/O error', async () => {
    const task = makeMigratedToolTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const mockFs = makeMockFs(
      [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      {
        exists: vi.fn().mockImplementation((path: string, fileMap: Map<string, string>) => {
          if (path === resultPath) {
            const err = new Error('EIO') as NodeJS.ErrnoException;
            err.code = 'EIO';
            return Promise.reject(err);
          }
          return Promise.resolve(fileMap.has(path));
        }),
      },
    );
    const { audit, events } = makeMockAudit();

    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(mockFs.move).not.toHaveBeenCalled();
    expect(sendToolResult).not.toHaveBeenCalled();
    expect(await mockFs.exists(taskFile)).toBe(true);

    const failedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
        (col) => typeof col === 'string' && col.includes('context=migrated_result_exists_io_error'),
      ),
    );
    expect(failedEvents.length).toBe(1);
  });

  it('keeps task in running when result read() throws I/O error', async () => {
    const task = makeMigratedToolTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const mockFs = makeMockFs(
      [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      {
        read: vi.fn().mockImplementation((path: string, fileMap: Map<string, string>) => {
          if (path === resultPath) {
            const err = new Error('EIO') as NodeJS.ErrnoException;
            err.code = 'EIO';
            return Promise.reject(err);
          }
          const content = fileMap.get(path);
          if (content === undefined) {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            return Promise.reject(err);
          }
          return Promise.resolve(content);
        }),
      },
    );
    // Pre-populate result file so exists() returns true.
    await mockFs.writeAtomic(resultPath, 'output');
    const { audit, events } = makeMockAudit();

    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(sendToolResult).not.toHaveBeenCalled();
    expect(await mockFs.exists(taskFile)).toBe(true);

    const failedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
        (col) => typeof col === 'string' && col.includes('context=migrated_result_read_io_error'),
      ),
    );
    expect(failedEvents.length).toBe(1);
  });

  it('skips re-delivery when sent marker exists and moves to done', async () => {
    const task = makeMigratedToolTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const sentMarkerPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt.sent`;

    const mockFs = makeMockFs([{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }]);
    await mockFs.writeAtomic(resultPath, 'output');
    await mockFs.writeAtomic(sentMarkerPath, '1');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(sendToolResult).not.toHaveBeenCalled();
    expect(await mockFs.exists('tasks/queues/done/550e8400-e29b-41d4-a716-446655440000.json')).toBe(true);

    const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
    expect(recoveredEvents.length).toBe(1);
    expect(recoveredEvents[0]).toContain('reason=migrated_sent_marker_found');
  });
});

describe('phase 889: retry counter I/O errors stop recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops recovery when retry counter read fails with non-ENOENT error', async () => {
    const task = makeSubAgentTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const retryPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt.retry-count`;

    const mockFs = makeMockFs(
      [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      {
        read: vi.fn().mockImplementation((path: string, fileMap: Map<string, string>) => {
          if (path === retryPath) {
            const err = new Error('EACCES') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            return Promise.reject(err);
          }
          const content = fileMap.get(path);
          if (content === undefined) {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            return Promise.reject(err);
          }
          return Promise.resolve(content);
        }),
      },
    );
    await mockFs.writeAtomic(resultPath, 'result content');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(sendResult).not.toHaveBeenCalled();
    expect(await mockFs.exists(taskFile)).toBe(true);

    const failedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
        (col) => typeof col === 'string' && col.includes('context=retry_counter_read_failed'),
      ),
    );
    expect(failedEvents.length).toBe(1);
  });

  it('stops recovery when retry counter write fails', async () => {
    const task = makeSubAgentTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const resultPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt`;
    const retryPath = `tasks/queues/results/${VALID_TASK_ID}/result.txt.retry-count`;

    vi.mocked(sendResult).mockRejectedValueOnce(new Error('delivery failed'));
    vi.mocked(sendFallbackError).mockRejectedValueOnce(new Error('fallback fail'));

    const mockFs = makeMockFs(
      [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
      {
        writeAtomic: vi.fn().mockImplementation((path: string, content: string, fileMap: Map<string, string>) => {
          if (path === retryPath) {
            const err = new Error('disk full') as NodeJS.ErrnoException;
            err.code = 'ENOSPC';
            return Promise.reject(err);
          }
          fileMap.set(path, content);
          return Promise.resolve(undefined);
        }),
      },
    );
    await mockFs.writeAtomic(resultPath, 'result content');

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(sendResult).toHaveBeenCalledTimes(1);
    expect(await mockFs.exists(taskFile)).toBe(true);
    expect(await mockFs.exists(retryPath)).toBe(false);

    const failedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some(
        (col) => typeof col === 'string' && col.includes('context=retry_counter_persist_failed'),
      ),
    );
    expect(failedEvents.length).toBe(1);
  });
});
