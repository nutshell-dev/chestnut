import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';
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
});
