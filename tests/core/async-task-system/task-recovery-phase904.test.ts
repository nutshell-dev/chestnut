import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn().mockRejectedValue(new Error('send fail')),
  sendFallbackError: vi.fn().mockRejectedValue(new Error('fallback fail')),
  sendToolResult: vi.fn().mockResolvedValue(undefined),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn(),
    getProcessStartTime: vi.fn(),
  };
});

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

function makeMigratedTask(opts: { createdAt?: string; migratedPid?: number } = {}) {
  return {
    kind: 'tool' as const,
    id: VALID_TASK_ID,
    shortId: VALID_TASK_SHORT_ID,
    toolName: 'read',
    args: {},
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    parentClawDir: '/tmp',
    parentClawId: 'parent',
    createdAt: opts.createdAt ?? new Date().toISOString(),
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
    mode: 'migrated' as const,
    migratedPid: opts.migratedPid ?? 12345,
  };
}

function makeMockFs(opts: {
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
      if (dir === 'tasks/queues/failed') {
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

describe('phase 904: migrated recovery radical fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('kills migrated process when hard timeout exceeded', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const task = makeMigratedTask({ createdAt: '2020-01-01T00:00:00Z' });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(killSpy).toHaveBeenCalledWith(task.migratedPid, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('keeps task in running when sendFallbackError fails', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const task = makeMigratedTask();
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit, events } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(mockFs.move).not.toHaveBeenCalled();

    const fallbackFailedEvents = events.filter(
      (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e[2] === 'context=migrated_fallback_error_failed',
    );
    expect(fallbackFailedEvents.length).toBe(1);
  });

  it('keeps alive process in running when within deadline', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const task = makeMigratedTask({ createdAt: new Date().toISOString() });
    const taskFile = 'tasks/queues/running/task-1.json';
    const mockFs = makeMockFs({
      runningFiles: [{ name: 'task-1.json', path: taskFile, content: JSON.stringify(task) }],
    });

    const { audit } = makeMockAudit();
    await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

    expect(mockFs.move).not.toHaveBeenCalled();
  });
});
