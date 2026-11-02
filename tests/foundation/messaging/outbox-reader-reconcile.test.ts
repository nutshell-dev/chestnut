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

function enoent(p: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function makeMockFs(overrides: {
  list?: (dir: string) => Promise<{ name: string }[]>;
  read?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ mtime: Date; ctime: Date; size: number; isDirectory: boolean; isFile: boolean }>;
  move?: (src: string, dest: string) => Promise<void>;
  writeExclusiveSync?: (path: string, content: string) => void;
} = {}): FileSystem {
  return {
    list: overrides.list ?? vi.fn().mockResolvedValue([]),
    read: overrides.read ?? vi.fn().mockRejectedValue(enoent('default')),
    move: overrides.move ?? vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    delete: vi.fn(),
    removeDir: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn().mockResolvedValue(true),
    isDirectory: vi.fn().mockResolvedValue(true),
    stat: overrides.stat ?? vi.fn().mockResolvedValue({ mtime: new Date(0), ctime: new Date(0), size: 0, isDirectory: false, isFile: true }),
    utimes: vi.fn(),
    writeAtomicSync: vi.fn(),
    writeExclusiveSync: overrides.writeExclusiveSync ?? vi.fn(),
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

/** 三阶段协议的通用断言辅助：staging 路径形如 pending/.tmp_<uuid>_<orig>.staging。 */
function stagingPathFor(originalName: string): RegExp {
  return new RegExp(`^/claw/outbox/pending/\\.tmp_[0-9a-z]+_${originalName.replace('.', '\\.')}\\.staging$`);
}

describe('OutboxReader._reconcileProcessing lease + I/O safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips processing files owned by an alive process', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const pid = process.pid;
    const recentMtime = new Date();
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: `cli_${pid}_abc123_msg.md` }]);
        return Promise.resolve([]);
      }),
      stat: vi.fn().mockResolvedValue({ mtime: recentMtime, ctime: recentMtime, size: 0, isDirectory: false, isFile: true }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
  });

  it('reclaims processing files owned by a dead process via stage + O_EXCL publish', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc123_msg.md' }]);
        return Promise.resolve([]);
      }),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('msg content');
        return Promise.reject(enoent(p)); // pending target 缺失
      }),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    // Stage 1: processing → staging（绝不直接 rename 到 pending 目标）
    expect(fs.move).toHaveBeenCalledWith(
      '/claw/outbox/processing/cli_99999_abc123_msg.md',
      expect.stringMatching(stagingPathFor('msg.md')),
    );
    // Stage 2: O_EXCL 原子占位 + 删 staging
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'msg content');
    expect(fs.deleteSync).toHaveBeenCalledWith(expect.stringMatching(stagingPathFor('msg.md')));
    expect(events.some(e => e[0] === 'outbox_processing_orphan_cleaned')).toBe(true);
  });

  it('reclaims via mtime lease when startTime is unavailable (startTimeHex=0)', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const staleMtime = new Date(Date.now() - 6 * 60 * 1000);
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: `cli_${process.pid}_0_abc123_msg.md` }]);
        return Promise.resolve([]);
      }),
      stat: vi.fn().mockResolvedValue({ mtime: staleMtime, ctime: staleMtime, size: 0, isDirectory: false, isFile: true }),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('msg content');
        return Promise.reject(enoent(p));
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).toHaveBeenCalledWith(
      `/claw/outbox/processing/cli_${process.pid}_0_abc123_msg.md`,
      expect.stringMatching(stagingPathFor('msg.md')),
    );
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'msg content');
  });

  it('keeps processing file when startTime is unavailable but mtime lease has not expired', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const recentMtime = new Date(Date.now() - 1 * 60 * 1000);
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: `cli_${process.pid}_0_abc123_msg.md` }]);
        return Promise.resolve([]);
      }),
      stat: vi.fn().mockResolvedValue({ mtime: recentMtime, ctime: recentMtime, size: 0, isDirectory: false, isFile: true }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).not.toHaveBeenCalled();
  });

  it('reclaims old-token processing file via mtime lease even when PID is alive', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    const staleMtime = new Date(Date.now() - 6 * 60 * 1000);
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: `cli_${process.pid}_abc123_msg.md` }]);
        return Promise.resolve([]);
      }),
      stat: vi.fn().mockResolvedValue({ mtime: staleMtime, ctime: staleMtime, size: 0, isDirectory: false, isFile: true }),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('msg content');
        return Promise.reject(enoent(p));
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).toHaveBeenCalledWith(
      `/claw/outbox/processing/cli_${process.pid}_abc123_msg.md`,
      expect.stringMatching(stagingPathFor('msg.md')),
    );
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'msg content');
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
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('msg content');
        return Promise.reject(enoent(p));
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(isAlive).toHaveBeenCalledWith(process.pid, wrongStartTime);
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'msg content');
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

  it('archives staging copy when pending target already has identical content (dedupe)', async () => {
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

    // 目标已存在 → 不 O_EXCL，staging 副本归档 done/
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      expect.stringMatching(stagingPathFor('msg.md')),
      '/claw/outbox/done/cli_99999_abc_msg.md',
    );
  });

  it('moves staging copy to DLQ when pending target has different content (conflict)', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc_msg.md' }]);
        if (dir.includes('/pending')) return Promise.resolve([{ name: 'msg.md' }]);
        return Promise.resolve([]);
      }),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('processing content');
        return Promise.resolve('pending content');
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.ensureDir).toHaveBeenCalledWith('/claw/outbox/failed');
    expect(fs.move).toHaveBeenCalledWith(
      expect.stringMatching(stagingPathFor('msg.md')),
      '/claw/outbox/failed/cli_99999_abc_msg.md',
    );
  });
});

describe('OutboxReader._reconcileProcessing no-overwrite protocol (Phase 1908 Step G)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const deadOwnerList = () => vi.fn().mockImplementation((dir: string) => {
    if (dir.includes('/processing')) return Promise.resolve([{ name: 'cli_99999_abc123_msg.md' }]);
    return Promise.resolve([]); // pending 快照为空 —— 目标在快照后出现
  });

  it('target appears after the snapshot (EEXIST) with different content → staging to DLQ, target untouched', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    let targetAppeared = false;
    const fs = makeMockFs({
      list: deadOwnerList(),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('stale content');
        if (p.includes('/pending/msg.md')) {
          return targetAppeared ? Promise.resolve('fresh content') : Promise.reject(enoent(p));
        }
        return Promise.reject(enoent(p));
      }),
      writeExclusiveSync: vi.fn().mockImplementation(() => {
        targetAppeared = true;
        const err = new Error('file already exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    // 快照后出现的 pending 目标不被覆盖：EEXIST 后重读比较，异内容 → staging 进 DLQ
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'stale content');
    expect(fs.deleteSync).not.toHaveBeenCalled();
    expect(fs.ensureDir).toHaveBeenCalledWith('/claw/outbox/failed');
    expect(fs.move).toHaveBeenCalledWith(
      expect.stringMatching(stagingPathFor('msg.md')),
      '/claw/outbox/failed/cli_99999_abc123_msg.md',
    );
    // 从不存在 processing → pending/<orig> 的裸 rename
    expect(fs.move).not.toHaveBeenCalledWith(
      '/claw/outbox/processing/cli_99999_abc123_msg.md',
      '/claw/outbox/pending/msg.md',
    );
  });

  it('target appears after the snapshot (EEXIST) with identical content → staging archived to done (dedupe)', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    let targetAppeared = false;
    const fs = makeMockFs({
      list: deadOwnerList(),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('same content');
        if (p.includes('/pending/msg.md')) {
          return targetAppeared ? Promise.resolve('same content') : Promise.reject(enoent(p));
        }
        return Promise.reject(enoent(p));
      }),
      writeExclusiveSync: vi.fn().mockImplementation(() => {
        targetAppeared = true;
        const err = new Error('file already exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.move).toHaveBeenCalledWith(
      expect.stringMatching(stagingPathFor('msg.md')),
      '/claw/outbox/done/cli_99999_abc123_msg.md',
    );
    expect(fs.deleteSync).not.toHaveBeenCalled();
  });

  it('source vanished before staging (race-lost) → skip without touching pending', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: deadOwnerList(),
      move: vi.fn().mockRejectedValue(enoent('processing gone')),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.deleteSync).not.toHaveBeenCalled();
  });

  it('non-ENOENT staging failure is audited and does not touch pending target', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const fs = makeMockFs({
      list: deadOwnerList(),
      move: vi.fn().mockRejectedValue(new Error('EIO')),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(events.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=reconcile_pending'))).toBe(true);
  });
});


describe('OutboxReader startup staging recovery (Phase 2049 Step C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a crash-leftover stage when the pending target is missing', async () => {
    const stageName = '.tmp_deadbeef_msg.md.staging';
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('/processing')) return Promise.resolve([]);
        return Promise.resolve([{ name: stageName }]);
      }),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.endsWith(stageName)) return Promise.resolve('staged content');
        return Promise.reject(enoent(p));
      }),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'staged content');
    expect(fs.deleteSync).toHaveBeenCalledWith(`/claw/outbox/pending/${stageName}`);
    expect(events.some(e =>
      e[0] === 'outbox_reconcile' &&
      String(e).includes('from=stage') &&
      String(e).includes('to=pending') &&
      String(e).includes('reverted_count=1')
    )).toBe(true);
    const listedDirs = (fs.list as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]);
    expect(listedDirs).toEqual([
      '/claw/outbox/processing',
      '/claw/outbox/pending',
      '/claw/outbox/pending',
    ]);
  });

  it('archives a stage copy when the pending target has identical content', async () => {
    const stageName = '.tmp_deadbeef_msg.md.staging';
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => Promise.resolve(
        dir.includes('/pending') ? [{ name: stageName }] : [],
      )),
      read: vi.fn().mockResolvedValue('same content'),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      `/claw/outbox/pending/${stageName}`,
      expect.stringMatching(/^\/claw\/outbox\/done\/\d+_[0-9a-f]{8}_msg\.md$/),
    );
    expect(events.some(e =>
      e[0] === 'outbox_reconcile' && String(e).includes('reason=startup_stage_recover_dedupe')
    )).toBe(true);
  });

  it('quarantines a conflicting stage copy without replacing pending content', async () => {
    const stageName = '.tmp_deadbeef_msg.md.staging';
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => Promise.resolve(
        dir.includes('/pending') ? [{ name: stageName }] : [],
      )),
      read: vi.fn().mockImplementation((p: string) => Promise.resolve(
        p.endsWith(stageName) ? 'staged content' : 'pending content',
      )),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      `/claw/outbox/pending/${stageName}`,
      expect.stringMatching(/^\/claw\/outbox\/failed\/\d+_[0-9a-f]{8}_msg\.md$/),
    );
    expect(events.some(e =>
      e[0] === 'outbox_stage_quarantine' && String(e).includes('reason=conflict')
    )).toBe(true);
  });

  it('quarantines an unparseable staging filename with audit', async () => {
    const stageName = '.tmp_not-a-stage.staging';
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => Promise.resolve(
        dir.includes('/pending') ? [{ name: stageName }] : [],
      )),
    });
    const { audit, events } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(fs.read).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      `/claw/outbox/pending/${stageName}`,
      expect.stringMatching(/^\/claw\/outbox\/failed\/\d+_[0-9a-f]{8}_quarantine_staging_\.tmp_not-a-stage\.staging$/),
    );
    expect(events.some(e =>
      e[0] === 'outbox_stage_quarantine' && String(e).includes('reason=unparseable_staging_format')
    )).toBe(true);
  });
});


describe('OutboxReader startTime-less claim lease (Phase 2049 Step D)', () => {
  it('reclaims a dead PID immediately even when the mtime lease is fresh', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(false);

    const pid = 424242;
    const recentMtime = new Date();
    const fs = makeMockFs({
      list: vi.fn().mockImplementation((dir: string) => Promise.resolve(
        dir.includes('/processing') ? [{ name: `cli_${pid}_0_abc123_msg.md` }] : [],
      )),
      stat: vi.fn().mockResolvedValue({ mtime: recentMtime, ctime: recentMtime, size: 0, isDirectory: false, isFile: true }),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('.staging')) return Promise.resolve('msg content');
        return Promise.reject(enoent(p));
      }),
    });
    const { audit } = makeAudit();
    const reader = new OutboxReader(fs, audit);

    await reader.init('/claw');

    expect(isAlive).toHaveBeenCalledWith(pid);
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith('/claw/outbox/pending/msg.md', 'msg content');
  });
});
