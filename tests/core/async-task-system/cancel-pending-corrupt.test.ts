import { describe, it, expect, vi, afterEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

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

describe('cancel pending task with corrupt JSON triggers backupCorruptTask audit (phase 1012)', () => {
  afterEach(() => {
    capturedWatcherCallback = undefined;
    vi.clearAllMocks();
  });

  it('corrupt JSON parse fail → backupCorruptTask audit TASK_CORRUPT + file still moved to failed', async () => {
    const auditEvents: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEvents.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };

    const mockFs: FileSystem = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-bad.json') {
          return Promise.resolve('not valid json');
        }
        return Promise.resolve('');
      }),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-bad.json') {
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      }),
    } as unknown as FileSystem;

    const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });

    await system.cancel('task-bad');

    // corrupt input → TASK_CORRUPT audit emitted
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

    // file still moved to failed
    expect(mockFs.move).toHaveBeenCalledWith(
      'tasks/queues/pending/task-bad.json',
      'tasks/queues/failed/task-bad.json',
    );

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });

  it('valid JSON but shape mismatch → backupCorruptTask audit + file moved to failed', async () => {
    const auditEvents: Array<[string, ...(string | number)[]]> = [];
    const audit: AuditLog = {
      write: (type: string, ...cols: (string | number)[]) => {
        auditEvents.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };

    const mockFs: FileSystem = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      resolve: vi.fn((p: string) => `/abs/${p}`),
      read: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-shape.json') {
          return Promise.resolve(JSON.stringify({ id: 'x', kind: 'bogus' }));
        }
        return Promise.resolve('');
      }),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      writeAtomic: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((filePath: string) => {
        if (filePath === 'tasks/queues/pending/task-shape.json') {
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      }),
    } as unknown as FileSystem;

    const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });

    await system.cancel('task-shape');

    const corruptEvents = auditEvents.filter((e) => e[0] === TASK_AUDIT_EVENTS.TASK_CORRUPT);
    expect(corruptEvents.length).toBe(1);
    expect(corruptEvents[0]).toEqual(
      expect.arrayContaining([
        TASK_AUDIT_EVENTS.TASK_CORRUPT,
        expect.stringContaining('error=shape_mismatch'),
      ]),
    );

    expect(mockFs.move).toHaveBeenCalledWith(
      'tasks/queues/pending/task-shape.json',
      'tasks/queues/failed/task-shape.json',
    );

    await system.shutdown(1).catch(() => { /* silent: shutdown */ });
  });
});
