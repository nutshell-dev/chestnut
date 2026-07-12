import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { makeProcessStartTime } from '../../../src/foundation/process-exec/process-starttime.js';

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn(),
  };
});

function makeAudit(): { audit: AuditLog; events: Array<[string, ...unknown[]]> } {
  const events: Array<[string, ...unknown[]]> = [];
  const audit: AuditLog = {
    write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
  };
  return { audit, events };
}

function makeMockFs(overrides: {
  list?: (dir: string) => Promise<{ name: string }[]>;
  read?: (path: string) => Promise<string>;
} = {}): FileSystem {
  return {
    list: overrides.list ?? vi.fn().mockResolvedValue([]),
    read: overrides.read ?? vi.fn().mockResolvedValue(''),
    move: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    delete: vi.fn(),
    removeDir: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn().mockResolvedValue(true),
    isDirectory: vi.fn().mockResolvedValue(true),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(0), ctime: new Date(0), size: 0, isDirectory: false, isFile: true }),
    utimes: vi.fn(),
    writeAtomicSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    writeExclusive: vi.fn(),
    readSync: vi.fn(),
    readBytesSync: vi.fn(),
    appendSync: vi.fn(),
    statSync: vi.fn(),
    moveSync: vi.fn(),
    existsSync: vi.fn(),
    ensureDirSync: vi.fn(),
    listSync: vi.fn(),
    removeDirSync: vi.fn(),
    realpathSync: vi.fn(),
    isDirectorySync: vi.fn(),
    utimesSync: vi.fn(),
    deleteSync: vi.fn(),
    syncSync: vi.fn(),
    resolve: vi.fn((p: string) => `/abs/${p}`),
  } as unknown as FileSystem;
}

describe('OutboxReader._reconcileProcessing lease + I/O safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips processing files owned by an alive process', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const pid = process.pid;
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: `cli_${pid}_abc123_msg.md` }]);
        return Promise.resolve([]);
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
  });

  it('reclaims processing files owned by a dead process', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc123_msg.md' }]);
        return Promise.resolve([]);
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).toHaveBeenCalledWith(
      '/claw/outbox/processing/cli_99999_abc123_msg.md',
      '/claw/outbox/pending/msg.md',
    );
  });

  it('reclaims when PID is alive but startTime differs', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    const wrongStartTime = makeProcessStartTime('Mon Jan 01 00:00:00 2020');
    vi.mocked(isAlive).mockImplementation((_pid: number, startTime?: unknown) => startTime !== wrongStartTime);

    const wrongHex = Buffer.from(wrongStartTime).toString('hex');
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: `cli_${process.pid}_${wrongHex}_abc123_msg.md` }]);
        return Promise.resolve([]);
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(isAlive).toHaveBeenCalledWith(process.pid, wrongStartTime);
    expect(fs.move).toHaveBeenCalledWith(
      `/claw/outbox/processing/cli_${process.pid}_${wrongHex}_abc123_msg.md`,
      '/claw/outbox/pending/msg.md',
    );
  });

  it('aborts reconcile when pending list fails', async () => {
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc123_msg.md' }]);
        return Promise.reject(new Error('EACCES'));
      }),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
    expect(events.some(e => e[0] === 'outbox_list_failed' && String(e).includes('op=reconcile'))).toBe(true);
  });

  it('archives processing file when duplicate content matches', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc_msg.md' }]);
        if (dir.includes('/pending')) return Promise.resolve([{ name: 'msg.md' }]);
        return Promise.resolve([]);
      }),
      read: vi.fn().mockResolvedValue('same content'),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).toHaveBeenCalledWith(
      '/claw/outbox/processing/cli_99999_abc_msg.md',
      '/claw/outbox/done/cli_99999_abc_msg.md',
    );
  });

  it('moves processing file to DLQ when duplicate content differs', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc_msg.md' }]);
        if (dir.includes('/pending')) return Promise.resolve([{ name: 'msg.md' }]);
        return Promise.resolve([]);
      }),
      read: vi.fn()
        .mockResolvedValueOnce('processing content')
        .mockResolvedValueOnce('pending content'),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.ensureDir).toHaveBeenCalledWith('/claw/outbox/failed');
    expect(fs.move).toHaveBeenCalledWith(
      '/claw/outbox/processing/cli_99999_abc_msg.md',
      '/claw/outbox/failed/cli_99999_abc_msg.md',
    );
  });
});
