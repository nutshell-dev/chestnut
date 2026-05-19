import { describe, it, expect, vi } from 'vitest';
import { runMetricsSnapshot, type MetricsSnapshotOptions } from '../../../src/core/cron/jobs/metrics-snapshot.js';
import { CRON_AUDIT_EVENTS } from '../../../src/core/cron/audit-events.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

function makeMockFs(dirs: Record<string, DirEntry[]>): FileSystem {
  return {
    existsSync: vi.fn((path: string) => path in dirs),
    listSync: vi.fn((path: string) => dirs[path] ?? []),
    // minimal stubs
    readSync: vi.fn(() => ''),
    appendSync: vi.fn(),
    ensureDirSync: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0 })),
    realpathSync: vi.fn((p: string) => p),
  } as unknown as FileSystem;
}

function makeMockAudit(): { audit: AuditLog; writes: Array<{ type: string; cols: string[] }> } {
  const writes: Array<{ type: string; cols: string[] }> = [];
  return {
    audit: { write: (type: string, ...cols: (string | number)[]) => writes.push({ type, cols: cols.map(String) }) },
    writes,
  };
}

describe('metrics-snapshot', () => {
  it('反向 1: snapshot emit 含预期 9 字段', async () => {
    const dirs: Record<string, DirEntry[]> = {
      '/m/inbox/pending':  [{ name: '1.md', isDirectory: false, size: 100 }],
      '/m/inbox/done':     [{ name: 'a.md', isDirectory: false, size: 100 }, { name: 'b.md', isDirectory: false, size: 100 }],
      '/m/inbox/failed':   [],
      '/m/outbox/pending': [{ name: 'x.md', isDirectory: false, size: 50 }],
      '/m/outbox/done':    [],
      '/m/outbox/failed':  [],
      '/m/tasks/pending':  [],
      '/m/tasks/queues/pending': [{ name: 'q1.md', isDirectory: false, size: 200 }],
      '/m/tasks/running':  [],
    };
    const fs = makeMockFs(dirs);
    const { audit, writes } = makeMockAudit();

    await runMetricsSnapshot({ motionDir: '/m', fs, audit });

    expect(writes.length).toBe(1);
    expect(writes[0].type).toBe(CRON_AUDIT_EVENTS.METRICS_SNAPSHOT);
    const joined = writes[0].cols.join(' ');
    expect(joined).toContain('inbox_pending=1');
    expect(joined).toContain('inbox_done=2');
    expect(joined).toContain('inbox_failed=0');
    expect(joined).toContain('outbox_pending=1');
    expect(joined).toContain('tasks_queue_pending=1');
  });

  it('反向 2: all dirs empty → 全 0 snapshot', async () => {
    const dirs: Record<string, DirEntry[]> = {
      '/m/inbox/pending':  [],
      '/m/inbox/done':     [],
      '/m/inbox/failed':   [],
      '/m/outbox/pending': [],
      '/m/outbox/done':    [],
      '/m/outbox/failed':  [],
      '/m/tasks/pending':  [],
      '/m/tasks/queues/pending': [],
      '/m/tasks/running':  [],
    };
    const fs = makeMockFs(dirs);
    const { audit, writes } = makeMockAudit();

    await runMetricsSnapshot({ motionDir: '/m', fs, audit });

    expect(writes.length).toBe(1);
    const joined = writes[0].cols.join(' ');
    expect(joined).toBe('inbox_pending=0 inbox_done=0 inbox_failed=0 outbox_pending=0 outbox_done=0 outbox_failed=0 tasks_pending=0 tasks_queue_pending=0 tasks_running=0');
  });

  it('反向 3: dir missing → skip 不 throw + partial counts', async () => {
    // 仅部分目录存在
    const dirs: Record<string, DirEntry[]> = {
      '/m/inbox/pending': [{ name: 'only.md', isDirectory: false, size: 10 }],
    };
    const fs = makeMockFs(dirs);
    const { audit, writes } = makeMockAudit();

    // 不应 throw
    await runMetricsSnapshot({ motionDir: '/m', fs, audit });

    expect(writes.length).toBe(1);
    const joined = writes[0].cols.join(' ');
    // 存在的目录有计数，不存在的目录 = 0 (existsSync returns false → countDir returns 0)
    expect(joined).toContain('inbox_pending=1');
    expect(joined).toContain('inbox_done=0');
    expect(joined).toContain('outbox_pending=0');
    expect(joined).toContain('tasks_running=0');
  });
});
