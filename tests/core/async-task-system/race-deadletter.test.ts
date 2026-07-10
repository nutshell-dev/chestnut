/**
 * Phase 556: race + dead-letter cluster fix
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverTasks, type RecoverTasksDeps } from '../../../src/core/async-task-system/task-recovery.js';
import { sendResult } from '../../../src/core/async-task-system/result-delivery.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import { waitFor } from '../../helpers/wait-for.js';


vi.mock('../../../src/core/async-task-system/result-delivery.js', () => ({
  sendResult: vi.fn(),
  sendFallbackError: vi.fn().mockRejectedValue(new Error('fallback failed')),
  SENT_MARKER: (taskId: string) => `tasks/queues/results/${taskId}/result.txt.sent`,
}));

// phase 260: hoist; 4 tests previously did `await import` for the same module per call.
import { sendFallbackError } from '../../../src/core/async-task-system/result-delivery.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('phase 556: race + dead-letter cluster fix', () => {
  // ─── C1 β: cancel during ingest await race ─────────────────────────────────
  describe('C1 β: cancel during _ingestPendingFile fs.read await', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(async () => {
      vi.restoreAllMocks();

      vi.mocked(sendFallbackError).mockRejectedValue(new Error('fallback failed'));

      mockFs = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
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
    });

    it('cancel during _ingestPendingFile fs.read await must prevent dispatch', async () => {
      const taskId = '11111111-1111-4111-9111-111111111111';
      const filePath = `tasks/queues/pending/${taskId}.json`;

      let resolveRead!: (v: string) => void;
      let ingestReadDeferred = true;
      mockFs.read = vi.fn().mockImplementation((path: string) => {
        if (path === filePath && ingestReadDeferred) {
          ingestReadDeferred = false;
          return new Promise((resolve) => { resolveRead = resolve; });
        }
        if (path === filePath) {
          return Promise.resolve(JSON.stringify({
            kind: 'subagent',
            mode: 'standard',
            id: taskId,
            shortId: '11111111',
            intent: 'test',
            timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
            maxSteps: 1,
            parentClawId: 'parent',
            createdAt: new Date().toISOString(),
          }));
        }
        return Promise.resolve('');
      });

      let resolveExists!: (v: boolean) => void;
      let existsDeferred = true;
      mockFs.exists = vi.fn().mockImplementation((path: string) => {
        if (path.includes('pending') && path.includes(taskId)) {
          if (existsDeferred) {
            existsDeferred = false;
            return new Promise((resolve) => { resolveExists = resolve; });
          }
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      });

      mockFs.move = vi.fn().mockResolvedValue(undefined);

      const enqueueSpy = vi.spyOn(system as any, '_enqueueAndDispatch');

      const ingestPromise = (system as any)._ingestPendingFile(filePath);
      const cancelPromise = system.cancel(taskId);

      // 等一个 tick，让 cancel 执行到 await fs.exists 并挂起
      await new Promise(setImmediate);

      // resolve fs.read（此时 cancellingIds 中仍有 taskId）
      resolveRead(JSON.stringify({
        kind: 'subagent',
        mode: 'standard',
        id: taskId,
        shortId: taskId,
        intent: 'test',
        timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
        maxSteps: 1,
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
      }));

      // 等 ingest 完成
      await ingestPromise;

      // 让 cancel 继续执行
      resolveExists(true);
      await cancelPromise;

      // 断言：_enqueueAndDispatch 未被调用（race re-check 拦截了 ghost dispatch）
      expect(enqueueSpy).not.toHaveBeenCalled();
    });
  });

  // ─── C2: dead-letter cluster ───────────────────────────────────────────────
  describe('C2: dead-letter cluster', () => {
    beforeEach(async () => {
      vi.mocked(sendFallbackError).mockRejectedValue(new Error('fallback failed'));
    });

    const taskJson = JSON.stringify({
      kind: 'subagent',
      mode: 'standard',
      id: 'deadbeef-dead-4ead-bead-deadbeefdead',
      shortId: 'deadbeef',
      intent: 'test',
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      maxSteps: 1,
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
    });

    it('dead-letter path cleans up retry counter file', async () => {
      const { audit, events } = makeMockAudit();
      const retryPath = 'tasks/queues/results/deadbeef-dead-4ead-bead-deadbeefdead/result.txt.retry-count';

      const mockFs = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') {
            return Promise.resolve([{ name: 'task-dead.json', path: 'tasks/queues/running/task-dead.json' }]);
          }
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          if (path === 'tasks/queues/running/task-dead.json') return Promise.resolve(taskJson);
          if (path === 'tasks/queues/results/deadbeef-dead-4ead-bead-deadbeefdead/result.txt') return Promise.resolve('result data');
          if (path === retryPath) return Promise.resolve('3');
          return Promise.resolve('');
        }),
        exists: vi.fn().mockImplementation((path: string) => {
          if (path.includes('.sent')) return Promise.resolve(false);
          if (path === 'tasks/queues/results/deadbeef-dead-4ead-bead-deadbeefdead/result.txt') return Promise.resolve(true);
          if (path === retryPath) return Promise.resolve(true);
          return Promise.resolve(false);
        }),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystem;

      (sendResult as any).mockRejectedValue(new Error('send failed'));

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      // retryPath 应该被 delete 调用过
      const deleteCalls = (mockFs.delete as any).mock.calls;
      const deletedPaths = deleteCalls.map((c: any) => c[0]);
      expect(deletedPaths).toContain(retryPath);

      // audit 含 RECOVERY_DEAD_LETTER
      const deadLetterEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER,
      );
      expect(deadLetterEvents.length).toBe(1);
    });

    it('dead-letter move failure audits dead_letter_move_failed', async () => {
      const { audit, events } = makeMockAudit();
      const retryPath = 'tasks/queues/results/deadbeef-dead-4ead-bead-deadbeefdead/result.txt.retry-count';

      const mockFs = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') {
            return Promise.resolve([{ name: 'task-dead.json', path: 'tasks/queues/running/task-dead.json' }]);
          }
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          if (path === 'tasks/queues/running/task-dead.json') return Promise.resolve(taskJson);
          if (path === 'tasks/queues/results/deadbeef-dead-4ead-bead-deadbeefdead/result.txt') return Promise.resolve('result data');
          if (path === retryPath) return Promise.resolve('3');
          return Promise.resolve('');
        }),
        exists: vi.fn().mockImplementation((path: string) => {
          if (path.includes('.sent')) return Promise.resolve(false);
          if (path === 'tasks/queues/results/deadbeef-dead-4ead-bead-deadbeefdead/result.txt') return Promise.resolve(true);
          return Promise.resolve(false);
        }),
        move: vi.fn().mockImplementation((_src: string, dest: string) => {
          if (dest.includes('failed')) {
            return Promise.reject(new Error('move to failed failed'));
          }
          return Promise.resolve();
        }),
        delete: vi.fn().mockResolvedValue(undefined),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystem;

      (sendResult as any).mockRejectedValue(new Error('send failed'));

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      const moveFailedEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some((c) => typeof c === 'string' && c.includes('context=dead_letter_move_failed')),
      );
      expect(moveFailedEvents.length).toBe(1);
      expect(moveFailedEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.RECOVERY_FAILED,
          expect.stringContaining('taskId='),
          'context=dead_letter_move_failed',
          expect.stringContaining('error='),
        ]),
      );
    });
  });

  // ─── P1.7: concurrent ingest race (phase 612) ────────────────────────────────
  describe('P1.7 _ingestPendingFile concurrent race (phase 612)', () => {
    let system: AsyncTaskSystem;
    let mockFs: FileSystem;
    let auditEvents: Array<[string, ...(string | number)[]]>;

    beforeEach(async () => {
      vi.restoreAllMocks();

      vi.mocked(sendFallbackError).mockRejectedValue(new Error('fallback failed'));

      mockFs = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
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
    });

    it('prevents double start 同 taskId on concurrent ingest', async () => {
      const taskId = '44444444-4444-4444-a444-444444444444';
      const filePath = `tasks/queues/pending/${taskId}.json`;
      const taskObj = {
        kind: 'subagent' as const,
        id: taskId,
        shortId: '44444444',
        intent: 'test',
        timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
        maxSteps: 1,
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
      };

      const defers: Array<{ resolve: (v: typeof taskObj) => void }> = [];
      mockFs.exists = vi.fn().mockResolvedValue(false);
      mockFs.move = vi.fn().mockResolvedValue(undefined);

      const startSpy = vi.spyOn(system as any, '_startTask').mockResolvedValue(undefined);
      vi.spyOn(system as any, '_loadTaskFromFile').mockImplementation(() => {
        return new Promise((resolve) => { defers.push({ resolve: resolve as any }); });
      });
      vi.spyOn(system as any, '_getPendingTaskIds').mockResolvedValue(new Set([taskId]));
      vi.spyOn(system as any, '_getPendingTasks').mockResolvedValue([taskObj]);

      // Phase 802: dispatch loop is persistent and must be started before _signalWork() can wake it.
      void (system as any)._runDispatchLoop();

      // 并发触发两次 _ingestPendingFile
      const p1 = (system as any)._ingestPendingFile(filePath);
      const p2 = (system as any)._ingestPendingFile(filePath);

      // phase 789: waitFor poll until both reads are suspended on the deferred loader
      await waitFor(() => defers.length === 2, 5000);
      expect(defers.length).toBe(2);

      // 同时 resolve 两个 read
      defers[0].resolve(taskObj);
      defers[1].resolve(taskObj);

      await p1;
      await p2;

      // 断言：_startTask 只被调用一次（dispatch loop guard 防重）
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('still prevents ghost dispatch during cancel race (phase 556 regression)', async () => {
      const taskId = '55555555-5555-4555-a555-555555555555';
      const filePath = `tasks/queues/pending/${taskId}.json`;

      let resolveRead!: (v: string) => void;
      let ingestReadDeferred = true;
      mockFs.read = vi.fn().mockImplementation((path: string) => {
        if (path === filePath && ingestReadDeferred) {
          ingestReadDeferred = false;
          return new Promise((resolve) => { resolveRead = resolve; });
        }
        if (path === filePath) {
          return Promise.resolve(JSON.stringify({
            kind: 'subagent',
            mode: 'standard',
            id: taskId,
            shortId: '11111111',
            intent: 'test',
            timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
            maxSteps: 1,
            parentClawId: 'parent',
            createdAt: new Date().toISOString(),
          }));
        }
        return Promise.resolve('');
      });

      let resolveExists!: (v: boolean) => void;
      let existsDeferred = true;
      mockFs.exists = vi.fn().mockImplementation((path: string) => {
        if (path.includes('pending') && path.includes(taskId)) {
          if (existsDeferred) {
            existsDeferred = false;
            return new Promise((resolve) => { resolveExists = resolve; });
          }
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      });

      mockFs.move = vi.fn().mockResolvedValue(undefined);

      const enqueueSpy = vi.spyOn(system as any, '_enqueueAndDispatch');

      const ingestPromise = (system as any)._ingestPendingFile(filePath);
      const cancelPromise = system.cancel(taskId);

      await new Promise(setImmediate);

      resolveRead(JSON.stringify({
        kind: 'subagent',
        id: taskId,
        shortId: taskId,
        intent: 'test',
        timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
        maxSteps: 1,
        parentClawId: 'parent',
        createdAt: new Date().toISOString(),
      }));

      await ingestPromise;

      resolveExists(true);
      await cancelPromise;

      expect(enqueueSpy).not.toHaveBeenCalled();
    });
  });

  // ─── P1.8: retryCount<MAX retry pending (phase 612) ──────────────────────────
  describe('P1.8 retryCount<MAX retry pending (phase 612)', () => {
    beforeEach(async () => {
      vi.mocked(sendFallbackError).mockRejectedValue(new Error('fallback failed'));
    });

    const taskJson = JSON.stringify({
      kind: 'subagent',
      mode: 'standard',
      id: '33333333-3333-4333-a333-333333333333',
      shortId: '33333333',
      intent: 'test',
      timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
      maxSteps: 1,
      parentClawId: 'parent',
      createdAt: new Date().toISOString(),
    });

    it('keeps task in running/ when retryCount<MAX (not move DONE)', async () => {
      const { audit, events } = makeMockAudit();
      const retryPath = 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt.retry-count';

      const mockFs = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') {
            return Promise.resolve([{ name: 'task-retry.json', path: 'tasks/queues/running/task-retry.json' }]);
          }
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          if (path === 'tasks/queues/running/task-retry.json') return Promise.resolve(taskJson);
          if (path === 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt') return Promise.resolve('result data');
          if (path === retryPath) return Promise.resolve('1');
          return Promise.resolve('');
        }),
        exists: vi.fn().mockImplementation((path: string) => {
          if (path.includes('.sent')) return Promise.resolve(false);
          if (path === 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt') return Promise.resolve(true);
          if (path === retryPath) return Promise.resolve(true);
          return Promise.resolve(false);
        }),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystem;

      (sendResult as any).mockRejectedValue(new Error('send failed'));

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      // task 不应被 move 到 DONE
      const moveCalls = (mockFs.move as any).mock.calls;
      const doneMoves = moveCalls.filter((c: any) => c[1] && c[1].includes('done'));
      expect(doneMoves.length).toBe(0);

      // retry counter 应被更新为 2
      const writeAtomicCalls = (mockFs.writeAtomic as any).mock.calls;
      const retryWrites = writeAtomicCalls.filter((c: any) => c[0] === retryPath);
      expect(retryWrites.length).toBe(1);
      expect(retryWrites[0][1]).toBe('2');

      // audit 应含 RECOVERY_FAILED context=retry_pending
      const retryPendingEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_FAILED && e.some((c) => typeof c === 'string' && c.includes('context=retry_pending')),
      );
      expect(retryPendingEvents.length).toBe(1);
      expect(retryPendingEvents[0]).toEqual(
        expect.arrayContaining([
          TASK_AUDIT_EVENTS.RECOVERY_FAILED,
          expect.stringContaining('taskId='),
          'context=retry_pending',
          'retryCount=2',
          'maxRetries=3',
        ]),
      );

      // 不应有 RECOVERED audit
      const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
      expect(recoveredEvents.length).toBe(0);
    });

    it('moves to dead-letter when retryCount >= MAX (regression)', async () => {
      const { audit, events } = makeMockAudit();
      const retryPath = 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt.retry-count';

      const mockFs = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') {
            return Promise.resolve([{ name: 'task-retry.json', path: 'tasks/queues/running/task-retry.json' }]);
          }
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          if (path === 'tasks/queues/running/task-retry.json') return Promise.resolve(taskJson);
          if (path === 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt') return Promise.resolve('result data');
          if (path === retryPath) return Promise.resolve('2');
          return Promise.resolve('');
        }),
        exists: vi.fn().mockImplementation((path: string) => {
          if (path.includes('.sent')) return Promise.resolve(false);
          if (path === 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt') return Promise.resolve(true);
          if (path === retryPath) return Promise.resolve(true);
          return Promise.resolve(false);
        }),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystem;

      (sendResult as any).mockRejectedValue(new Error('send failed'));

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      // task 应被 move 到 FAILED
      const moveCalls = (mockFs.move as any).mock.calls;
      const failedMoves = moveCalls.filter((c: any) => c[1] && c[1].includes('failed'));
      expect(failedMoves.length).toBe(1);

      // audit 应含 RECOVERY_DEAD_LETTER
      const deadLetterEvents = events.filter(
        (e) => e[0] === TASK_AUDIT_EVENTS.RECOVERY_DEAD_LETTER,
      );
      expect(deadLetterEvents.length).toBe(1);
    });

    it('moves to DONE when resultSent=true (success regression)', async () => {
      const { audit, events } = makeMockAudit();
      const retryPath = 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt.retry-count';

      const mockFs = {
        list: vi.fn().mockImplementation((dir: string) => {
          if (dir === 'tasks/queues/running') {
            return Promise.resolve([{ name: 'task-retry.json', path: 'tasks/queues/running/task-retry.json' }]);
          }
          return Promise.resolve([]);
        }),
        read: vi.fn().mockImplementation((path: string) => {
          if (path === 'tasks/queues/running/task-retry.json') return Promise.resolve(taskJson);
          if (path === 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt') return Promise.resolve('result data');
          if (path === retryPath) return Promise.resolve('1');
          return Promise.resolve('');
        }),
        exists: vi.fn().mockImplementation((path: string) => {
          if (path.includes('.sent')) return Promise.resolve(false);
          if (path === 'tasks/queues/results/33333333-3333-4333-a333-333333333333/result.txt') return Promise.resolve(true);
          if (path === retryPath) return Promise.resolve(true);
          return Promise.resolve(false);
        }),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystem;

      (sendResult as any).mockResolvedValue(undefined);

      await recoverTasks({ fs: mockFs, auditWriter: audit } as RecoverTasksDeps);

      // task 应被 move 到 DONE
      const moveCalls = (mockFs.move as any).mock.calls;
      const doneMoves = moveCalls.filter((c: any) => c[1] && c[1].includes('done'));
      expect(doneMoves.length).toBe(1);

      // SENT_MARKER 应被写入
      const writeAtomicCalls = (mockFs.writeAtomic as any).mock.calls;
      const sentMarkerWrites = writeAtomicCalls.filter((c: any) => c[0].includes('.sent'));
      expect(sentMarkerWrites.length).toBe(1);

      // retryPath 应被删除
      const deleteCalls = (mockFs.delete as any).mock.calls;
      const deletedPaths = deleteCalls.map((c: any) => c[0]);
      expect(deletedPaths).toContain(retryPath);

      // audit 应含 RECOVERED
      const recoveredEvents = events.filter((e) => e[0] === TASK_AUDIT_EVENTS.RECOVERED);
      expect(recoveredEvents.length).toBe(1);
    });
  });
});
