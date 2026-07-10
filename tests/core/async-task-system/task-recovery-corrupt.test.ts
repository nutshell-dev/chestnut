import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

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

function makeValidTask(kind: 'subagent' | 'tool' = 'subagent') {
  const base = {
    kind,
    id: 'task-1',
    shortId: 'task1',
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  };
  if (kind === 'subagent') {
    return {
      ...base,
      mode: 'standard',
      intent: 'test',
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      maxSteps: 1,
    };
  }
  return {
    ...base,
    toolName: 'read',
    args: {},
    parentClawDir: '/tmp',
    isIdempotent: true,
    maxRetries: 2,
    retryCount: 0,
  };
}

function makeMockFsForRecovery(opts: {
  runningFiles?: Array<{ name: string; path: string; content: string }>;
  pendingFiles?: Array<{ name: string; path: string; content: string }>;
} = {}): FileSystem {
  const running = opts.runningFiles ?? [];
  const pending = opts.pendingFiles ?? [];
  const fileMap = new Map<string, string>();
  const backupPaths: string[] = [];

  for (const f of running) fileMap.set(f.path, f.content);
  for (const f of pending) fileMap.set(f.path, f.content);

  return {
    list: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'tasks/queues/running') {
        return Promise.resolve(running.map((f) => ({ name: f.name, path: f.path })));
      }
      if (dir === 'tasks/queues/pending') {
        return Promise.resolve(pending.map((f) => ({ name: f.name, path: f.path })));
      }
      return Promise.resolve([]);
    }),
    read: vi.fn().mockImplementation((filePath: string) => {
      const content = fileMap.get(filePath);
      if (content === undefined) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(content);
    }),
    move: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes('.corrupt-')) {
        backupPaths.push(filePath);
      }
      fileMap.delete(filePath);
      return Promise.resolve(undefined);
    }),
    writeAtomic: vi.fn().mockImplementation((filePath: string, content: string) => {
      if (filePath.includes('.corrupt-')) {
        backupPaths.push(filePath);
      }
      fileMap.set(filePath, content);
      return Promise.resolve(undefined);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
  } as unknown as FileSystem;
}

let capturedWatcherCallback: ((event: { type: string; path: string }) => void) | undefined;

vi.mock('../../../src/foundation/file-watcher/index.js', () => ({
  createWatcher: vi.fn((_path: string, callback: (event: { type: string; path: string }) => void) => {
    capturedWatcherCallback = callback;
    return {
      close: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(true),
      getPath: vi.fn().mockReturnValue(_path),
    };
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('task-recovery corrupt-backup 三件套', () => {
  afterEach(() => {
    capturedWatcherCallback = undefined;
    vi.clearAllMocks();
  });

  // ─── recoverTasks / _recoverRunningTasks ────────────────────────────────────

  describe('_recoverRunningTasks', () => {
    it('反向 1：JSON.parse fail → backup .corrupt-<ts> + audit TASK_CORRUPT + skip recovery', async () => {
      const mockFs = makeMockFsForRecovery({
        runningFiles: [{ name: 'task-bad.json', path: 'tasks/queues/running/task-bad.json', content: 'invalid json' }],
      });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const corruptEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('backup='),
          expect.stringContaining('move_ok=true'),
          expect.stringContaining('error='),
        ]),
      );

      // running file should have been deleted after backup
      expect(mockFs.delete).toHaveBeenCalledWith('tasks/queues/running/task-bad.json');
      // no RECOVERY_FAILED for parse error (TASK_CORRUPT replaces it for corrupt files)
      const recoveryFailed = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
      expect(recoveryFailed.length).toBe(0);
    });

    it('反向 2：valid JSON but shape mismatch → backup + audit + skip recovery', async () => {
      const mockFs = makeMockFsForRecovery({
        runningFiles: [
          { name: 'task-bad.json', path: 'tasks/queues/running/task-bad.json', content: JSON.stringify({ id: 'x', kind: 'bogus' }) },
        ],
      });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const corruptEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('backup='),
          expect.stringContaining('move_ok=true'),
          expect.stringContaining('error=shape_mismatch'),
        ]),
      );
    });

    it('反向 3：valid task JSON + shape ok → no backup + recovery succeeds', async () => {
      const mockFs = makeMockFsForRecovery({
        runningFiles: [
          { name: 'task-1.json', path: 'tasks/queues/running/task-1.json', content: JSON.stringify(makeValidTask('subagent')) },
        ],
      });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const corruptEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(0);

      // task should be moved to pending (recovered)
      expect(mockFs.move).toHaveBeenCalledWith(
        'tasks/queues/running/task-1.json',
        'tasks/queues/pending/task-1.json',
      );
    });

    it('backup move fail → audit move_ok=false + move_error', async () => {
      const mockFs = makeMockFsForRecovery({
        runningFiles: [
          { name: 'task-bad.json', path: 'tasks/queues/running/task-bad.json', content: 'invalid json' },
        ],
      });
      vi.mocked(mockFs.writeAtomic).mockRejectedValue(new Error('disk full'));
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const corruptEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('backup='),
          'move_ok=false',
          expect.stringContaining('move_error=disk full'),
        ]),
      );
    });
  });

  // ─── recoverTasks / _loadPendingTasks ───────────────────────────────────────

  describe('_loadPendingTasks', () => {
    it('pending JSON.parse fail → backup + audit + skip', async () => {
      const mockFs = makeMockFsForRecovery({
        pendingFiles: [{ name: 'task-bad.json', path: 'tasks/queues/pending/task-bad.json', content: 'not json' }],
      });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const corruptEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('backup='),
          expect.stringContaining('move_ok=true'),
        ]),
      );
    });

    it('pending shape mismatch → backup + audit + skip', async () => {
      const mockFs = makeMockFsForRecovery({
        pendingFiles: [
          { name: 'task-bad.json', path: 'tasks/queues/pending/task-bad.json', content: JSON.stringify({ id: 'x', kind: 'unknown' }) },
        ],
      });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const corruptEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('error=shape_mismatch'),
        ]),
      );
    });
  });

  // ─── system.ts / _loadPendingTask ───────────────────────────────────────────

  describe('_loadTaskFromFile (system.ts)', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(() => {
      mockFs = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        read: vi.fn().mockResolvedValue(''),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockResolvedValue(false),
      } as unknown as FileSystem;

      auditEvents = [];
      const audit: AuditLog = {
        write: (type: string, ...cols: (string | number)[]) => {
          auditEvents.push([type, ...cols]);
        },
        preview: (s: string) => s,
        message: (s: string) => s,
        summary: (s: string) => s,
      };

      system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
        ...makeTaskSystemDeps(),
      });
    });

    afterEach(async () => {
      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
      capturedWatcherCallback = undefined;
    });

    it('JSON.parse fail → backup + audit TASK_CORRUPT + return null (skip ingest)', async () => {
      vi.mocked(mockFs.read).mockResolvedValue('bad json');

      const result = await (system as any)._loadTaskFromFile('tasks/queues/pending/task-bad.json');

      expect(result).toBeNull();

      const corruptEvents = auditEvents.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('backup='),
          expect.stringContaining('move_ok=true'),
          expect.stringContaining('error='),
        ]),
      );
    });

    it('shape mismatch → backup + audit + return null', async () => {
      vi.mocked(mockFs.read).mockResolvedValue(JSON.stringify({ id: 'x', kind: 'bogus' }));

      const result = await (system as any)._loadTaskFromFile('tasks/queues/pending/task-bad.json');

      expect(result).toBeNull();

      const corruptEvents = auditEvents.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(1);
      expect(corruptEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.TASK_CORRUPT,
          expect.stringContaining('error=shape_mismatch'),
        ]),
      );
    });

    it('valid task → no backup + return task', async () => {
      vi.mocked(mockFs.read).mockResolvedValue(JSON.stringify(makeValidTask('tool')));

      const result = await (system as any)._loadTaskFromFile('tasks/queues/pending/task-1.json');

      expect(result).not.toBeNull();
      expect(result.id).toBe('task-1');

      const corruptEvents = auditEvents.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
      expect(corruptEvents.length).toBe(0);
    });
  });
});
