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

  it('returns null when pending is empty', async () => {
    expect(await reader.claimNext(clawDir)).toBeNull();
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
    expect(claimed).not.toBeNull();
    expect(claimed?.filename).toBe(`${t1}_normal_aaa.md`);
    expect(claimed?.content).toContain('earlier');
    expect(claimed?.claimPath.startsWith('outbox/processing/cli_')).toBe(true);
    expect(claimed?.claimPath.endsWith(`_${t1}_normal_aaa.md`)).toBe(true);

    // pending oldest gone, processing has claimed file
    const pendingFiles = (await fsAsync.readdir(pendingDir)).sort();
    expect(pendingFiles).toEqual([`${t2}_normal_bbb.md`]);
    const processingFiles = await fsAsync.readdir(processingDir);
    expect(processingFiles.length).toBe(1);
    expect(processingFiles[0]).toMatch(/^cli_.*_1717480000000_normal_aaa\.md$/);
  });

  it('markDone moves processing file to done and emits delivered audit', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    await fsAsync.writeFile(
      path.join(pendingDir, filename),
      encodeOutbox(makeMsg('hello', '2026-06-04T10:00:00Z')),
    );

    const claimed = await reader.claimNext(clawDir);
    expect(claimed).not.toBeNull();

    await reader.markDone(clawDir, claimed!.claimPath, claimed!.filename);

    expect(await fsAsync.readdir(processingDir).catch(() => [])).toEqual([]);
    const doneFiles = await fsAsync.readdir(doneDir);
    expect(doneFiles.length).toBe(1);
    expect(doneFiles[0]).toMatch(/^\d+_1717480000000_normal_aaa\.md$/);
    expect(auditEvents.some(e => String(e[0]).includes('outbox_delivered') && String(e).includes(`file=${filename}`))).toBe(true);
  });

  it('returns null on race lost (file disappears before claim)', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    await fsAsync.writeFile(path.join(pendingDir, filename), encodeOutbox(makeMsg('x', '2026-06-04T10:00:00Z')));

    const originalList = reader.listClawOutboxPending.bind(reader);
    reader.listClawOutboxPending = async (dir: string) => {
      const list = await originalList(dir);
      if (list.includes(filename)) {
        await fsAsync.rm(path.join(pendingDir, filename)).catch(() => { /* silent: cleanup */ });
      }
      return list;
    };

    expect(await reader.claimNext(clawDir)).toBeNull();
  });

  it('reconciles orphaned processing files back to pending on init', async () => {
    const t1 = '1717480000000';
    const filename = `${t1}_normal_aaa.md`;
    const processingFile = `cli_99999_abc123_${filename}`;
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
  move?: () => Promise<void>;
  read?: () => Promise<string>;
}): FileSystem {
  return {
    list: overrides?.list ?? vi.fn().mockResolvedValue([{ name: '1717480000000_normal_aaa.md', path: '/outbox/pending/1717480000000_normal_aaa.md' }]),
    read: overrides?.read ?? vi.fn().mockResolvedValue(encodeOutbox(makeMsg('x', '2026-06-04T10:00:00Z'))),
    move: overrides?.move ?? vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    delete: vi.fn(),
    removeDir: vi.fn(),
    realpath: vi.fn(),
    exists: vi.fn().mockResolvedValue(true),
    isDirectory: vi.fn().mockResolvedValue(true),
    stat: vi.fn(),
    utimes: vi.fn(),
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

    expect(result).toBeNull();
    expect(auditEvents.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=move'))).toBe(true);
  });

  it('rolls back to pending when read fails after successful claim', async () => {
    const fs = makeMockOutboxFs({
      move: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' })),
    });
    const reader = new OutboxReader(fs, audit);

    const result = await reader.claimNext('/claw');

    expect(result).toBeNull();
    // First move: pending -> processing; Second move: processing -> pending (rollback)
    expect(fs.move).toHaveBeenCalledTimes(2);
    const calls = (fs.move as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatch(/outbox\/pending/);
    expect(calls[0][1]).toMatch(/outbox\/processing/);
    expect(calls[1][0]).toMatch(/outbox\/processing/);
    expect(calls[1][1]).toMatch(/outbox\/pending/);
    expect(auditEvents.some(e => e[0] === 'outbox_claim_failed' && String(e).includes('op=read'))).toBe(true);
  });
});
