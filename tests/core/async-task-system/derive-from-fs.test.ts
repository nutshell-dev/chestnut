import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncTaskSystem } from '../../../src/core/async-task-system/system.js';
import { InMemoryShortIdIndex } from '../../../src/core/async-task-system/short-id-index.js';
import { TASK_AUDIT_EVENTS } from '../../../src/core/async-task-system/audit-events.js';
import { makeTaskSystemDeps } from '../../helpers/task-system.js';
import { SUBAGENT_SHORT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
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

function makeTaskJson(fullId: string): string {
  return JSON.stringify({
    kind: 'subagent',
    mode: 'standard',
    id: fullId,
    shortId: fullId.slice(0, 8),
    intent: 'test',
    timeoutMs: SUBAGENT_SHORT_TIMEOUT_MS,
    maxSteps: 1,
    parentClawId: 'parent',
    createdAt: new Date().toISOString(),
  });
}

describe('derive from fs (phase 284 Step A)', () => {
  let system: AsyncTaskSystem;
  let mockFs: FileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;

  beforeEach(() => {
    const files = new Map<string, string>();

    mockFs = {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockImplementation((dir: string) => {
        const entries: Array<{ name: string; path: string; isDirectory: false; isFile: true; size: number; mtime: Date }> = [];
        for (const [path, _content] of files) {
          if (path.startsWith(dir)) {
            const name = path.slice(path.lastIndexOf('/') + 1);
            entries.push({ name, path, isDirectory: false, isFile: true, size: 100, mtime: new Date() });
          }
        }
        return Promise.resolve(entries);
      }),
      read: vi.fn().mockImplementation((path: string) => {
        const content = files.get(path);
        if (content === undefined) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve(content);
      }),
      writeAtomic: vi.fn().mockImplementation((path: string, content: string) => {
        files.set(path, content);
        return Promise.resolve(undefined);
      }),
      move: vi.fn().mockImplementation((from: string, to: string) => {
        const content = files.get(from);
        if (content !== undefined) {
          files.delete(from);
          files.set(to, content);
        }
        return Promise.resolve(undefined);
      }),
      delete: vi.fn().mockImplementation((path: string) => {
        files.delete(path);
        return Promise.resolve(undefined);
      }),
      exists: vi.fn().mockImplementation((path: string) => Promise.resolve(files.has(path))),
      resolve: vi.fn((p: string) => `/abs/${p}`),
    } as unknown as FileSystem;

    const { audit, events } = makeMockAudit();
    auditEvents = events;

    system = new AsyncTaskSystem('/tmp/claw', mockFs, {
      shortIdIndex: new InMemoryShortIdIndex(),
      auditWriter: audit,
      ...makeTaskSystemDeps(),
    });
  });

  it('_getPendingTasks returns all valid pending tasks sorted by createdAt', async () => {
    await mockFs.writeAtomic('tasks/queues/pending/11111111-1111-4111-9111-111111111111.json', makeTaskJson('11111111-1111-4111-9111-111111111111'));
    await mockFs.writeAtomic('tasks/queues/pending/22222222-2222-4222-a222-222222222222.json', makeTaskJson('22222222-2222-4222-a222-222222222222'));

    const tasks = await (system as any)._getPendingTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t: { id: string }) => t.id).sort()).toEqual(['11111111-1111-4111-9111-111111111111', '22222222-2222-4222-a222-222222222222']);
  });

  it('_getPendingTasks filters cancellingIds', async () => {
    await mockFs.writeAtomic('tasks/queues/pending/11111111-1111-4111-9111-111111111111.json', makeTaskJson('11111111-1111-4111-9111-111111111111'));
    await mockFs.writeAtomic('tasks/queues/pending/22222222-2222-4222-a222-222222222222.json', makeTaskJson('22222222-2222-4222-a222-222222222222'));

    (system as any).cancellingIds.add('22222222-2222-4222-a222-222222222222');

    const tasks = await (system as any)._getPendingTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('11111111-1111-4111-9111-111111111111');
  });

  it('_getPendingTasks skips corrupt files and emits audit', async () => {
    await mockFs.writeAtomic('tasks/queues/pending/33333333-3333-4333-a333-333333333333.json', makeTaskJson('33333333-3333-4333-a333-333333333333'));
    await mockFs.writeAtomic('tasks/queues/pending/bad.json', 'not json');

    const tasks = await (system as any)._getPendingTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('33333333-3333-4333-a333-333333333333');

    const violations = auditEvents.filter(
      e => e[0] === TASK_AUDIT_EVENTS.ASYNC_TASK_INVARIANT_VIOLATED && e.some(c => typeof c === 'string' && c.includes('derive_pending_corrupt')),
    );
    expect(violations.length).toBe(1);
  });

  it('_getPendingTaskIds returns ids excluding cancellingIds', async () => {
    await mockFs.writeAtomic('tasks/queues/pending/11111111-1111-4111-9111-111111111111.json', makeTaskJson('11111111-1111-4111-9111-111111111111'));
    await mockFs.writeAtomic('tasks/queues/pending/22222222-2222-4222-a222-222222222222.json', makeTaskJson('22222222-2222-4222-a222-222222222222'));
    (system as any).cancellingIds.add('22222222-2222-4222-a222-222222222222');

    const ids = await (system as any)._getPendingTaskIds();
    expect(ids).toEqual(new Set(['11111111-1111-4111-9111-111111111111']));
  });

  it('listPending returns pending ids derived from fs', async () => {
    await mockFs.writeAtomic('tasks/queues/pending/11111111-1111-4111-9111-111111111111.json', makeTaskJson('11111111-1111-4111-9111-111111111111'));
    await mockFs.writeAtomic('tasks/queues/pending/22222222-2222-4222-a222-222222222222.json', makeTaskJson('22222222-2222-4222-a222-222222222222'));

    const ids = await system.listPending();
    expect(ids.sort()).toEqual(['11111111', '22222222']);
  });

  it('getPendingCount returns count derived from fs', async () => {
    await mockFs.writeAtomic('tasks/queues/pending/11111111-1111-4111-9111-111111111111.json', makeTaskJson('11111111-1111-4111-9111-111111111111'));
    await mockFs.writeAtomic('tasks/queues/pending/22222222-2222-4222-a222-222222222222.json', makeTaskJson('22222222-2222-4222-a222-222222222222'));

    expect(await system.getPendingCount()).toBe(2);
  });
});
