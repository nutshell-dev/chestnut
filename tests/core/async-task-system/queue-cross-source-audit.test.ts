import { describe, it, expect, vi } from 'vitest';
import {
  auditQueueCrossSource,
  type QueueSnapshot,
} from '../../../src/core/async-task-system/queue-cross-source-audit.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

/**
 * Fire-and-forget audit microtask settle (10ms): 等 _ingestPendingFile 内 audit.write 落定.
 * Derivation: > microtask flush 1 turn / 给 fire-and-forget audit land 窗口.
 */
const AUDIT_MICROTASK_SETTLE_MS = 10;

function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
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

function makeMockFs(overrides?: {
  pendingFiles?: string[];
  runningFiles?: string[];
  listThrow?: boolean;
}): FileSystem {
  const pendingEntries: FileEntry[] = (overrides?.pendingFiles ?? []).map(name => ({
    name: `${name}.json`,
    path: `tasks/queues/pending/${name}.json`,
    isDirectory: false,
    isFile: true,
    size: 100,
    mtime: new Date(),
  }));
  const runningEntries: FileEntry[] = (overrides?.runningFiles ?? []).map(name => ({
    name: `${name}.json`,
    path: `tasks/queues/running/${name}.json`,
    isDirectory: false,
    isFile: true,
    size: 100,
    mtime: new Date(),
  }));

  return {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation((dir: string) => {
      if (overrides?.listThrow) return Promise.reject(new Error('list_failed'));
      if (dir === 'tasks/queues/pending') return Promise.resolve(pendingEntries);
      if (dir === 'tasks/queues/running') return Promise.resolve(runningEntries);
      return Promise.resolve([]);
    }),
    resolve: vi.fn((p: string) => `/abs/${p}`),
    read: vi.fn().mockResolvedValue(''),
    move: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation((dir: string) => {
      if (dir === 'tasks/queues/pending') return Promise.resolve(true);
      if (dir === 'tasks/queues/running') return Promise.resolve(true);
      return Promise.resolve(false);
    }),
  } as unknown as FileSystem;
}

describe('async-task queue cross-source audit (phase 284)', () => {
  describe('QC-4: cancellingIds 子集', () => {
    it('cancellingIds ⊆ active → 0 emit', async () => {
      const { audit, events } = makeAudit();
      const snapshot: QueueSnapshot = {
        cancellingIds: new Set(['a']),
      };
      const fs = makeMockFs({ pendingFiles: ['a'], runningFiles: ['b'] });
      await auditQueueCrossSource(snapshot, fs, audit, 'test');
      const mismatch = events.filter(e => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_MISMATCH);
      expect(mismatch).toHaveLength(0);
    });

    it('cancellingIds 含 orphan id → emit orphan', async () => {
      const { audit, events } = makeAudit();
      const snapshot: QueueSnapshot = {
        cancellingIds: new Set(['a', 'orphan']),
      };
      const fs = makeMockFs({ pendingFiles: ['a'], runningFiles: ['b'] });
      await auditQueueCrossSource(snapshot, fs, audit, 'test');
      const mismatch = events.filter(e => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_MISMATCH);
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0]).toEqual(expect.arrayContaining([
        expect.stringContaining('kind=qc4_cancelling_orphan'),
        expect.stringContaining('orphan_ids=orphan'),
        expect.stringContaining('orphan_count=1'),
      ]));
    });
  });

  describe('fs list 失败降级', () => {
    it('fs.list throw → emit _skipped + QC-4 跳', async () => {
      const { audit, events } = makeAudit();
      const snapshot: QueueSnapshot = {
        cancellingIds: new Set(['a']),
      };
      const fs = makeMockFs({ listThrow: true });
      await auditQueueCrossSource(snapshot, fs, audit, 'test');
      const skipped = events.filter(e => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_SKIPPED);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toEqual(expect.arrayContaining([
        expect.stringContaining('reason=fs_list_failed'),
        expect.stringContaining('trace=test'),
      ]));
      const mismatch = events.filter(e => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_MISMATCH);
      expect(mismatch).toHaveLength(0);
    });
  });

  describe('集成', () => {
    it('schedule → ingest → audit 跑、0 mismatch', async () => {
      const { audit, events } = makeAudit();
      const writes: Array<{ path: string; content: string }> = [];
      const mockFs: FileSystem = {
        ensureDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        resolve: vi.fn((p: string) => `/abs/${p}`),
        read: vi.fn().mockResolvedValue(''),
        move: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        writeAtomic: vi.fn().mockImplementation((p: string, c: string) => {
          writes.push({ path: p, content: c });
          return Promise.resolve();
        }),
        exists: vi.fn().mockResolvedValue(false),
      } as unknown as FileSystem;

      const system = new AsyncTaskSystem('/tmp/claw', mockFs, {
        auditWriter: audit,
        ...makeTaskSystemDeps(),
      });

      const taskId = await system.schedule('subagent', {
        kind: 'subagent',
        intent: 'test intent',
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
        maxSteps: 5,
        parentClawId: 'claw-1',
        mode: 'standard',
      });

      expect(taskId).toBeTruthy();

      // 手动触发 ingest（无 watcher 时）
      await (system as unknown as { _ingestPendingFile(path: string): Promise<void> })._ingestPendingFile(
        `tasks/queues/pending/${taskId}.json`,
      );

      // 给 microtask 一点时间让 fire-and-forget audit 完成
      await new Promise(r => setTimeout(r, AUDIT_MICROTASK_SETTLE_MS));

      const mismatch = events.filter(e => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_QUEUE_CROSS_SOURCE_MISMATCH);
      expect(mismatch).toHaveLength(0);

      await system.shutdown(1).catch(() => { /* silent: shutdown */ });
    });

    it('fire-and-forget 模式：主路径不 throw 不阻塞', async () => {
      const { audit, events } = makeAudit();
      const fs = makeMockFs({ listThrow: true });
      const snapshot: QueueSnapshot = {
        cancellingIds: new Set(),
      };
      await expect(auditQueueCrossSource(snapshot, fs, audit, 'test')).resolves.toBeUndefined();
      expect(events).toHaveLength(1);
    });
  });
});
