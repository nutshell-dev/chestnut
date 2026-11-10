import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { OutboxMoveFailed } from '../../../src/foundation/messaging/errors.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: {
      write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    },
    events,
  };
}

function makeMsg(content: string, ts: string): OutboxMessage {
  return {
    id: `m-${ts}`,
    type: 'response',
    from: 'clawA',
    to: 'motion',
    content,
    timestamp: ts,
    priority: 'normal',
  };
}

describe('OutboxReader.claimNext + markDone', () => {
  let root: string;
  let clawDir: string;
  let pendingDir: string;
  let processingDir: string;
  let doneDir: string;
  let fs: NodeFileSystem;
  let reader: OutboxReader;
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `claim-next-${randomUUID()}`);
    clawDir = path.join(root, 'claws/clawA');
    pendingDir = path.join(clawDir, 'outbox/pending');
    processingDir = path.join(clawDir, 'outbox/processing');
    doneDir = path.join(clawDir, 'outbox/done');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.mkdir(processingDir, { recursive: true });
    await fsAsync.mkdir(doneDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit, events } = makeAudit();
    auditEvents = events;
    reader = new OutboxReader(fs, audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty when pending is empty', async () => {
    expect(await reader.claimNext(clawDir)).toEqual({ status: 'empty' });
  });

  it('claims oldest pending message and moves it to processing', async () => {
    const t1 = '1717480000000';
    const t2 = '1717480000001';
    await fsAsync.writeFile(
      path.join(pendingDir, `${t2}_normal_bbb.md`),
      encodeOutbox(makeMsg('later', '2026-06-04T11:00:00Z')),
    );
    await fsAsync.writeFile(
      path.join(pendingDir, `${t1}_normal_aaa.md`),
      encodeOutbox(makeMsg('earlier', '2026-06-04T10:00:00Z')),
    );

    const claimed = await reader.claimNext(clawDir);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('unreachable');
    expect(claimed.filename).toBe(`${t1}_normal_aaa.md`);
    expect(claimed.content).toContain('earlier');
    expect(claimed.claimPath).toMatch(/^outbox\/processing\/mclaim_1_[0-9a-f-]+\.md$/);

    // pending oldest gone, processing has claimed file
    const pendingFiles = (await fsAsync.readdir(pendingDir)).sort();
    expect(pendingFiles).toEqual([`${t2}_normal_bbb.md`]);
    const processingFiles = await fsAsync.readdir(processingDir);
    expect(processingFiles.length).toBe(1);
    expect(processingFiles[0]).toMatch(/^mclaim_1_[0-9a-f-]+\.md$/);
  });

  it('anchors the claimed file mtime at claim time', async () => {
    const filename = '1717480000000_normal_aaa.md';
    const pendingPath = path.join(pendingDir, filename);
    await fsAsync.writeFile(pendingPath, encodeOutbox(makeMsg('hello', '2026-06-04T10:00:00Z')));
    const old = new Date('2000-01-01T00:00:00Z');
    await fsAsync.utimes(pendingPath, old, old);

    const before = Date.now();
    const claimed = await reader.claimNext(clawDir);
    const after = Date.now();

    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('unreachable');
    const stat = await fsAsync.stat(path.join(clawDir, claimed.claimPath));
    expect(stat.mtimeMs).toBeGreaterThan(old.getTime());
    expect(stat.mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(stat.mtimeMs).toBeLessThanOrEqual(after + 1000);
  });

  it('rejects path traversal in markDone', async () => {
    await expect(reader.markDone(clawDir, '../../../etc', 'test.md')).rejects.toThrow(/traversal/i);
  });

  it('markDone moves processing file to done and emits delivered audit', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    await fsAsync.writeFile(
      path.join(pendingDir, filename),
      encodeOutbox(makeMsg('hello', '2026-06-04T10:00:00Z')),
    );

    const claimed = await reader.claimNext(clawDir);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('unreachable');

    await reader.markDone(clawDir, claimed.claimPath, claimed.filename);

    expect(await fsAsync.readdir(processingDir).catch(() => [])).toEqual([]);
    const doneFiles = await fsAsync.readdir(doneDir);
    expect(doneFiles.length).toBe(1);
    expect(doneFiles[0]).toMatch(/^\d+_1717480000000_normal_aaa\.md$/);
    expect(auditEvents.some(e => String(e[0]).includes('outbox_delivered') && String(e).includes(`file=${filename}`))).toBe(true);
  });

  it('markDone audit payload includes deliveredAt (phase 1128 P1-9)', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    await fsAsync.writeFile(
      path.join(pendingDir, filename),
      encodeOutbox(makeMsg('hello', '2026-06-04T10:00:00Z')),
    );

    const claimed = await reader.claimNext(clawDir);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('unreachable');

    const before = Date.now();
    await reader.markDone(clawDir, claimed.claimPath, claimed.filename);
    const after = Date.now();

    const delivered = auditEvents.find(e => String(e[0]).includes('outbox_delivered'));
    expect(delivered).toBeDefined();
    const deliveredAtCol = delivered!.find(c => typeof c === 'string' && c.startsWith('deliveredAt='));
    expect(deliveredAtCol).toBeDefined();
    const deliveredAt = Number(String(deliveredAtCol).split('=')[1]);
    expect(deliveredAt).toBeGreaterThanOrEqual(before);
    expect(deliveredAt).toBeLessThanOrEqual(after);
    expect(String(delivered)).toContain(`file=${filename}`);
  });

  it('returns race_lost on race lost (file disappears before claim)', async () => {
    const fs = makeMockOutboxFs({
      move: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    });
    const { audit: raceAudit } = makeAudit();
    const reader = new OutboxReader(fs, raceAudit);

    const result = await reader.claimNext('/claw');

    expect(result).toEqual({ status: 'race_lost', error: 'file already claimed by concurrent consumer' });
  });

  it('reconciles orphaned processing files back to pending on init', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    const startTimeHex = Buffer.from('Mon Jan 01 00:00:00 2020').toString('hex');
    const processingFile = `cli_99999_${startTimeHex}_abc123_${filename}`;
    await fsAsync.writeFile(path.join(processingDir, processingFile), encodeOutbox(makeMsg('orphan', '2026-06-04T10:00:00Z')));

    await reader.init(clawDir);

    const pendingFiles = await fsAsync.readdir(pendingDir);
    expect(pendingFiles).toContain(filename);
    const processingFiles = await fsAsync.readdir(processingDir).catch(() => []);
    expect(processingFiles).not.toContain(processingFile);
    expect(auditEvents.some(e => e[0] === 'outbox_processing_orphan_cleaned')).toBe(true);
  });
});

function makeMockOutboxFs(overrides?: {
  list?: () => Promise<{ name: string; path: string }[]>;
  move?: (src: string, dest: string) => Promise<void>;
  read?: (path: string) => Promise<string>;
  utimes?: () => Promise<void>;
  writeExclusiveSync?: (path: string, content: string) => void;
  deleteSync?: (path: string) => void;
  mkdirExclusiveSync?: (path: string) => void;
}): FileSystem {
  return {
    list: overrides?.list ?? vi.fn().mockResolvedValue([{ name: '1717480000000_normal_aaa.md', path: '/outbox/pending/1717480000000_normal_aaa.md' }]),
    read: overrides?.read ?? vi.fn().mockResolvedValue(encodeOutbox(makeMsg('x', '2026-06-04T10:00:00Z'))),
    move: overrides?.move ?? vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn().mockResolvedValue({ kind: 'durable' }),
    append: vi.fn(),
    delete: vi.fn(),
    removeDir: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn().mockResolvedValue(true),
    isDirectory: vi.fn().mockResolvedValue(true),
    stat: vi.fn(),
    utimes: overrides?.utimes ?? vi.fn().mockResolvedValue(undefined),
    writeExclusiveSync: overrides?.writeExclusiveSync ?? vi.fn(),
    deleteSync: overrides?.deleteSync ?? vi.fn(),
    mkdirExclusiveSync: overrides?.mkdirExclusiveSync ?? vi.fn(),
  } as unknown as FileSystem;
}

describe('OutboxReader.claimNext I/O failure handling', () => {
  let audit: ReturnType<typeof makeAudit>['audit'];
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(() => {
    const made = makeAudit();
    audit = made.audit;
    auditEvents = made.events;
    vi.clearAllMocks();
  });

  it('audits non-ENOENT move error and returns null', async () => {
    const fs = makeMockOutboxFs({ move: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })) });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result).toEqual({ status: 'io_error', error: expect.stringContaining('EACCES') });
    expect(auditEvents.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=move'))).toBe(true);
  });

  it('rolls back to pending through staging when read fails after successful claim', async () => {
    const fs = makeMockOutboxFs({
      move: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockImplementation((p: string) => {
        if (p.includes('/processing/')) return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
        if (p.includes('.staging')) return Promise.resolve('rollback content');
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result).toEqual({ status: 'io_error', error: expect.stringContaining('EIO') });
    // First move: pending -> processing; second: processing -> unique staging.
    expect(fs.move).toHaveBeenCalledTimes(2);
    const calls = (fs.move as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatch(/outbox\/pending/);
    expect(calls[0][1]).toMatch(/outbox\/processing/);
    expect(calls[1][0]).toMatch(/outbox\/processing/);
    expect(calls[1][1]).toMatch(/outbox\/pending\/\.tmp_[0-9a-f]{8}_1717480000000_normal_aaa\.md\.staging$/);
    expect(fs.writeExclusiveSync).toHaveBeenCalledWith(
      '/claw/outbox/pending/1717480000000_normal_aaa.md',
      'rollback content',
    );
    expect(fs.deleteSync).toHaveBeenCalledWith(calls[1][1]);
    expect(auditEvents.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=read'))).toBe(true);
  });

  it('keeps a successful claim when lease utimes fails and audits the degradation', async () => {
    const fs = makeMockOutboxFs({
      utimes: vi.fn().mockRejectedValue(new Error('EPERM utimes')),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result.status).toBe('claimed');
    expect(auditEvents.some(e =>
      e[0] === 'outbox_claim_failed' && String(e).includes('op=claim_utimes')
    )).toBe(true);
  });

  it('returns io_error when list fails', async () => {
    const fs = makeMockOutboxFs({
      list: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES list'), { code: 'EACCES' })),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result).toEqual({ status: 'io_error', error: expect.stringContaining('EACCES list') });
    expect(auditEvents.some(e => e[0] === 'outbox_list_failed')).toBe(true);
  });

  it('returns recovery_required carrying both errors and claim identity when read fails and rollback fails', async () => {
    const fs = makeMockOutboxFs({
      move: vi.fn()
        .mockResolvedValueOnce(undefined) // claim move succeeds
        .mockRejectedValueOnce(Object.assign(new Error('EPERM rollback'), { code: 'EPERM' })),
      read: vi.fn().mockRejectedValue(Object.assign(new Error('EIO read'), { code: 'EIO' })),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result.status).toBe('recovery_required');
    if (result.status !== 'recovery_required') throw new Error('unreachable');
    expect(result.readError).toContain('EIO read');
    expect(result.rollbackError).toContain('EPERM rollback');
    expect(result.filename).toBe('1717480000000_normal_aaa.md');
    expect(result.claimPath).toMatch(/^outbox\/processing\/mclaim_1_[0-9a-f-]+\.md$/);
    // claim move + failed rollback move, nothing else (no deletion of the stuck file)
    expect(fs.move).toHaveBeenCalledTimes(2);
    expect(auditEvents.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=read'))).toBe(true);
    expect(auditEvents.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=read_rollback'))).toBe(true);
  });

  it('maps undecidable rollback outcome (claimed file vanished) to recovery_required, not io_error', async () => {
    const fs = makeMockOutboxFs({
      move: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      read: vi.fn().mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' })),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    // File location is not provably pending → caller must observe recovery_required
    // (conservative), not a plain io_error that would claim settlement completed.
    expect(result.status).toBe('recovery_required');
    if (result.status !== 'recovery_required') throw new Error('unreachable');
    expect(result.readError).toContain('EIO');
    expect(result.rollbackError).toContain('ENOENT');
    expect(result.claimPath).toContain('outbox/processing/');
  });
});


describe('OutboxReader rollback and settlement safety (Phase 2049 Step F)', () => {
  const filename = '1717480000000_normal_aaa.md';
  let audit: ReturnType<typeof makeAudit>['audit'];
  let auditEvents: ReturnType<typeof makeAudit>['events'];

  beforeEach(() => {
    const made = makeAudit();
    audit = made.audit;
    auditEvents = made.events;
  });

  function rollbackRead(targetContent: string) {
    return vi.fn().mockImplementation((p: string) => {
      if (p.includes('/processing/')) return Promise.reject(new Error('EIO claimed read'));
      if (p.includes('.staging')) return Promise.resolve('staged content');
      return Promise.resolve(targetContent);
    });
  }

  it('dedupes a same-content rollback target without overwriting pending', async () => {
    const fs = makeMockOutboxFs({
      read: rollbackRead('staged content'),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result.status).toBe('io_error');
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      expect.stringMatching(/outbox\/pending\/\.tmp_[0-9a-f]{8}_1717480000000_normal_aaa\.md\.staging$/),
      expect.stringMatching(/outbox\/done\/\d+_[0-9a-f]{8}_1717480000000_normal_aaa\.md$/),
    );
    expect(fs.move).not.toHaveBeenCalledWith(
      expect.stringContaining('/processing/'),
      `/claw/outbox/pending/${filename}`,
    );
    expect(auditEvents.some(e =>
      e[0] === 'outbox_reconcile' && String(e).includes('reason=claim_rollback_dedupe')
    )).toBe(true);
  });

  it('quarantines a conflicting rollback copy without overwriting pending', async () => {
    const fs = makeMockOutboxFs({
      read: rollbackRead('different pending content'),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result.status).toBe('io_error');
    expect(fs.writeExclusiveSync).not.toHaveBeenCalled();
    expect(fs.move).toHaveBeenCalledWith(
      expect.stringMatching(/outbox\/pending\/\.tmp_[0-9a-f]{8}_1717480000000_normal_aaa\.md\.staging$/),
      expect.stringMatching(/outbox\/failed\/\d+_[0-9a-f]{8}_1717480000000_normal_aaa\.md$/),
    );
    expect(fs.move).not.toHaveBeenCalledWith(
      expect.stringContaining('/processing/'),
      `/claw/outbox/pending/${filename}`,
    );
    expect(auditEvents.some(e =>
      e[0] === 'outbox_stage_quarantine' && String(e).includes('reason=conflict')
    )).toBe(true);
  });

  it('audits markDone move failure and throws OutboxMoveFailed', async () => {
    const fs = makeMockOutboxFs({ move: vi.fn().mockRejectedValue(new Error('EPERM archive')) });
    const reader = new OutboxReader(fs, audit);

    await expect(reader.markDone('/claw', `outbox/processing/cli_1_0_abc_${filename}`, filename))
      .rejects.toBeInstanceOf(OutboxMoveFailed);

    expect(auditEvents.some(e =>
      e[0] === 'outbox_claim_failed' && String(e).includes('op=done')
    )).toBe(true);
    expect(auditEvents.some(e => e[0] === 'outbox_delivered')).toBe(false);
  });

  it('audits markSkipped move failure and throws OutboxMoveFailed', async () => {
    const fs = makeMockOutboxFs({ move: vi.fn().mockRejectedValue(new Error('EPERM archive')) });
    const reader = new OutboxReader(fs, audit);

    await expect(reader.markSkipped('/claw', `outbox/processing/cli_1_0_abc_${filename}`, filename))
      .rejects.toBeInstanceOf(OutboxMoveFailed);

    expect(auditEvents.some(e =>
      e[0] === 'outbox_claim_failed' && String(e).includes('op=skipped')
    )).toBe(true);
    expect(auditEvents.some(e => e[0] === 'outbox_skipped')).toBe(false);
  });
});
