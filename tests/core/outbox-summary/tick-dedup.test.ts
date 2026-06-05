/**
 * phase 1476 / phase 42: tick orchestration + dedup integration tests.
 *
 * Covers:
 *  - 0 unread → CLEARED audit
 *  - first tick with unread → write new summary
 *  - re-tick same state → skip (pending hit dedup)
 *  - re-tick after motion drain/ack (done with prefix) → skip (done hit dedup within 24h)
 *  - re-tick after markDone prefix regression → skip via extraMeta (not filename pattern)
 *  - re-tick after done file aged > 24h → write new (mtime window expired)
 *  - state change (new msg) → write new summary, old stays pending
 *  - all unread consumed + new tick → CLEARED, old summary stays pending
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runOutboxSummaryTick, SUMMARY_INBOX_TYPE } from '../../../src/core/outbox-summary/index.js';
import { DEDUP_DONE_WINDOW_MS } from '../../../src/core/outbox-summary/dedup.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeChestnutRoot } from '../../../src/foundation/paths.js';
import { InboxReader, InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';

function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => { events.push([type, ...cols]); },
  };
  return { audit, events };
}

async function listSummaries(
  root: string,
  sub: 'pending' | 'done',
  fs: NodeFileSystem,
): Promise<string[]> {
  try {
    const dir = path.join(root, 'motion/inbox', sub);
    const names = await fsAsync.readdir(dir);
    const out: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const result = InboxWriter.readMeta(fs, path.join(dir, n));
      if (result.ok && result.value.type === SUMMARY_INBOX_TYPE) out.push(n);
    }
    return out;
  } catch { return []; }
}

describe('phase 42: runOutboxSummaryTick orchestration', () => {
  let root: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>['audit'];
  let events: ReturnType<typeof makeAudit>['events'];
  let inboxReader: InboxReader;
  let inboxWriter: InboxWriter;
  let outboxReader: OutboxReader;

  beforeEach(async () => {
    root = path.join(tmpdir(), `outbox-summary-tick-${randomUUID()}`);
    await fsAsync.mkdir(path.join(root, 'claws'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/done'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/failed'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'motion/inbox/inflight'), { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    ({ audit, events } = makeAudit());
    inboxReader = new InboxReader(
      path.join(root, 'motion/inbox/pending'),
      path.join(root, 'motion/inbox/done'),
      path.join(root, 'motion/inbox/failed'),
      fs,
      audit,
      path.join(root, 'motion/inbox/inflight'),
    );
    inboxWriter = InboxWriter.__internal_create(
      fs,
      makeInboxPath(path.join(root, 'motion/inbox/pending')),
      audit,
    );
    outboxReader = new OutboxReader(fs, audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('0 unread + no existing summary → no write, CLEARED audit', async () => {
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toEqual([]);
    expect(events.some(e => e[0] === 'cron_outbox_summary_cleared')).toBe(true);
  });

  it('first tick with unread → writes new summary + emits WRITTEN', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summaries = await listSummaries(root, 'pending', fs);
    expect(summaries.length).toBe(1);
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(true);
  });

  it('re-tick same state → SKIPPED (pending hit)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const firstSummary = (await listSummaries(root, 'pending', fs))[0];
    events.length = 0;
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect((await listSummaries(root, 'pending', fs))[0]).toBe(firstSummary);
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' && e.includes('reason=pending'))).toBe(true);
  });

  it('after motion drain/ack re-tick → SKIPPED (done hit within 24h)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const drained = await inboxReader.drainAndDeliver();
    expect(drained.handles.length).toBe(1);
    await inboxReader.ack(drained.handles[0]);

    events.length = 0;
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toEqual([]);
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' && e.includes('reason=done'))).toBe(true);
  });

  it('re-tick after markDone prefix → SKIPPED via extraMeta (not filename pattern)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const drained = await inboxReader.drainAndDeliver();
    await inboxReader.ack(drained.handles[0]);
    const doneFiles = await listSummaries(root, 'done', fs);
    expect(doneFiles.length).toBe(1);
    expect(doneFiles[0]).not.toBe((await listSummaries(root, 'pending', fs))[0]);

    events.length = 0;
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped')).toBe(true);
  });

  it('done file aged > 24h → write new (mtime window expired)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const drained = await inboxReader.drainAndDeliver();
    await inboxReader.ack(drained.handles[0]);
    const doneFiles = await fsAsync.readdir(path.join(root, 'motion/inbox/done'));
    const old = Date.now() - DEDUP_DONE_WINDOW_MS - 60_000;
    await fsAsync.utimes(path.join(root, 'motion/inbox/done', doneFiles[0]), old / 1000, old / 1000);

    events.length = 0;
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect((await listSummaries(root, 'pending', fs)).length).toBe(1);
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(true);
  });

  it('state change → writes new summary, old summary stays pending', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const firstSummary = (await listSummaries(root, 'pending', fs))[0];

    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m2.md'), 'y');
    events.length = 0;
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summaries = await listSummaries(root, 'pending', fs);
    expect(summaries.length).toBe(2);
    expect(summaries).toContain(firstSummary);
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(true);
  });

  it('all unread consumed + new tick → CLEARED, old summary stays pending', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summary = (await listSummaries(root, 'pending', fs))[0];
    await fsAsync.rm(path.join(root, 'claws/clawA/outbox/pending/m1.md'));

    events.length = 0;
    await runOutboxSummaryTick({
      chestnutRoot: makeChestnutRoot(root),
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toContain(summary);
    expect(events.some(e => e[0] === 'cron_outbox_summary_cleared')).toBe(true);
  });
});
