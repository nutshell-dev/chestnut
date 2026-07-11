/**
 * Phase 541: silent catch fixes — 3 sites audit + tests cascade
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { sendToolResult } from '../../../src/core/async-task-system/result-delivery.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import { waitFor } from '../../helpers/wait-for.js';


// ─── S1 helpers ───────────────────────────────────────────────────────────────

function makeMockFsForS1(opts: { moveReject?: boolean; deleteReject?: boolean } = {}): FileSystem {
  return {
    list: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'tasks/queues/running') {
        return Promise.resolve([{ name: 'task-1.json', path: 'tasks/queues/running/task-1.json' }]);
      }
      return Promise.resolve([]);
    }),
    read: vi.fn().mockResolvedValue(JSON.stringify({
      kind: 'subagent',
      mode: 'standard',
      id: '11111111-1111-4111-9111-111111111111',
      shortId: '11111111',
      intent: 'test',
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      maxSteps: 1,
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
    })),
    exists: vi.fn().mockImplementation((path: string) => {
      if (path.includes('.sent')) return Promise.resolve(true);
      return Promise.resolve(false);
    }),
    move: vi.fn().mockImplementation(() => {
      if (opts.moveReject) return Promise.reject(new Error('move failed'));
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation(() => {
      if (opts.deleteReject) return Promise.reject(new Error('delete failed'));
      return Promise.resolve();
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileSystem;
}

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

// ─── S3 helpers ───────────────────────────────────────────────────────────────

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

describe('phase 541: silent catch fixes', () => {
  // ─── S1 ─────────────────────────────────────────────────────────────────────
  describe('S1 task-recovery alreadySent move/delete failure', () => {
    it('move failure writes RECOVERY_FAILED audit (context=alreadysent_move_failed)', async () => {
      const mockFs = makeMockFsForS1({ moveReject: true, deleteReject: false });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const moveFailedEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some((c) => typeof c === 'string' && c.includes('context=alreadysent_move_failed')),
      );
      expect(moveFailedEvents.length).toBe(1);
      expect(moveFailedEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.RECOVERY_FAILED,
          expect.stringContaining('taskId='),
          'context=alreadysent_move_failed',
          expect.stringContaining('error='),
        ]),
      );
    });

    it('move failure keeps running file + writes RECOVERY_FAILED audit (no retry-count cleanup on failed move)', async () => {
      const mockFs = makeMockFsForS1({ moveReject: true, deleteReject: true });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const recoveryFailedEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
      // Phase 873: retry-count cleanup only happens after a successful move. On move failure,
      // only the move failure is audited; the running file is preserved for the next recovery.
      expect(recoveryFailedEvents.length).toBe(1);

      expect(recoveryFailedEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.RECOVERY_FAILED,
          expect.stringContaining('taskId='),
          'context=alreadysent_move_failed',
          expect.stringContaining('error='),
        ]),
      );
    });

    it('retry-count cleanup failure on successful move writes RECOVERY_FAILED audit (phase 18)', async () => {
      const mockFs = makeMockFsForS1({ moveReject: false, deleteReject: true });
      const { audit, events } = makeMockAudit();
      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const recoveryFailedEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED);
      expect(recoveryFailedEvents.length).toBe(1);

      expect(recoveryFailedEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.RECOVERY_FAILED,
          expect.stringContaining('taskId='),
          'context=retry_counter_cleanup_failed',
          expect.stringContaining('error='),
        ]),
      );
    });
  });

  // ─── S2 ─────────────────────────────────────────────────────────────────────
  describe('S2 result-delivery inline-fallback failure', () => {
    it('inline fallback failure writes INBOX_WRITE_FAILED audit (context=inline_fallback_failed)', async () => {
      let inboxWriteCount = 0;
      const mockFs = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        writeAtomic: vi.fn().mockImplementation((filePath: string) => {
          if (filePath.includes('result.txt')) return Promise.resolve();
          // inbox write 总是失败
          if (filePath.includes('inbox')) {
            inboxWriteCount++;
            return Promise.reject(new Error('inbox write failed'));
          }
          return Promise.resolve();
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystem;

      const { audit, events } = makeMockAudit();

      await expect(
        sendToolResult(mockFs, audit, {
          kind: 'tool',
          id: '22222222-2222-4222-a222-222222222222',
          shortId: '22222222',
          toolName: 'read',
          args: {},
          parentClawDir: '/tmp',
          parentClawId: 'parent',
          createdAt: new Date().toISOString(),
          isIdempotent: true,
          maxRetries: 2,
          retryCount: 0,
        }, { content: 'result data' }, false),
      ).rejects.toThrow('inbox write failed');

      const inlineFallbackEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.INBOX_WRITE_FAILED && e.some((c) => typeof c === 'string' && c.includes('context=inline_fallback_failed')),
      );
      expect(inlineFallbackEvents.length).toBe(1);
      expect(inlineFallbackEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.INBOX_WRITE_FAILED,
          expect.stringContaining('fullTaskId=22222222-2222-4222-a222-222222222222'),
          expect.stringContaining('shortTaskId=22222222'),
          'context=inline_fallback_failed',
          expect.stringContaining('error='),
        ]),
      );
    });
  });

  // ─── S3 ─────────────────────────────────────────────────────────────────────
  describe('S3 system.ts watcher async ingest failure', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(() => {
      mockFs = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        exists: vi.fn().mockResolvedValue(false),
        read: vi.fn().mockResolvedValue(''),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
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

    it('watcher async ingest reject writes PENDING_INGEST_FAILED audit (context=watcher_async)', async () => {
      await system.initialize();
      system.startDispatch();

      // 替换 _ingestPendingFile 让它 reject（模拟极端情况如同步 throw / audit 自身 throw）
      const originalIngest = (system as any)._ingestPendingFile.bind(system);
      (system as any)._ingestPendingFile = vi.fn().mockRejectedValue(new Error('ingest explosion'));

      expect(capturedWatcherCallback).toBeDefined();
      capturedWatcherCallback!({ type: 'add', path: 'tasks/queues/pending/task-watcher.json' });

      // phase 789: waitFor poll until PENDING_INGEST_FAILED (context=watcher_async) lands
      await waitFor(() => auditEvents.some(
        (e) => e[0] === TASK_AUDIT_EVENTS.PENDING_INGEST_FAILED && e.some((c) => typeof c === 'string' && c.includes('context=watcher_async')),
      ), 5000);

      const watcherAsyncEvents = auditEvents.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.PENDING_INGEST_FAILED && e.some((c) => typeof c === 'string' && c.includes('context=watcher_async')),
      );
      expect(watcherAsyncEvents.length).toBe(1);
      expect(watcherAsyncEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.PENDING_INGEST_FAILED,
          'context=watcher_async',
          'path=tasks/queues/pending/task-watcher.json',
          expect.stringContaining('error='),
        ]),
      );
    });
  });
});
