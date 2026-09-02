/**
 * phase 1476 / phase 42: tick orchestration + dedup integration tests.
 *
 * Covers:
 *  - 0 unread → no write, no audit
 *  - first tick with unread → write new summary
 *  - re-tick same state → skip silently (pending hit dedup)
 *  - re-tick after motion drain/ack (done with prefix) → skip silently (done hit dedup within 24h)
 *  - re-tick after markDone prefix regression → skip silently via extraMeta (not filename pattern)
 *  - re-tick after done file aged > 24h → write new (mtime window expired)
 *  - state change (new msg) → write new summary, old stays pending
 *  - all unread consumed + new tick → no write, no audit, old summary stays pending
 *  - phase 1749: repeat push (aged > 24h same hash) → body carries outbox-skip guidance
 *  - phase 1749: first push / new-hash push → body has no guidance
 */

import { makeChestnutRoot } from '../../../src/core/claw-topology/claw-instance-paths.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { runOutboxSummaryTick } from '../../../src/core/claw-topology/jobs/outbox-summary/tick.js';
import { SUMMARY_INBOX_TYPE } from '../../../src/core/claw-topology/jobs/outbox-summary/write.js';
import { DEDUP_DONE_WINDOW_MS } from '../../../src/core/claw-topology/jobs/outbox-summary/dedup.js';
import { decodeOutboxSummaryGuidance } from '../../../src/core/claw-topology/jobs/outbox-summary/guidance-state.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { InboxReader, InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';

function makeMsg(content: string, ts: string) {
  return {
    id: `m-${ts}`,
    type: 'report' as const,
    from: 'clawA',
    to: 'motion',
    content,
    timestamp: ts,
    priority: 'normal' as const,
  };
}

function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => { events.push([type, ...cols]); },
    preview: (s: string) => s,
    message: (s: string) => s,
    summary: (s: string) => s,
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
  let topology: ClawTopology;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
    topology = createClawTopology({
      fs,
      chestnutRoot: root,
      motionClawId: makeClawId('motion'),
      motionDir: 'motion',
    });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('0 unread + no existing summary → no write, no audit', async () => {
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toEqual([]);
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' || e[0] === 'cron_outbox_summary_cleared')).toBe(false);
  });

  it('first tick with unread → writes new summary + emits WRITTEN', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summaries = await listSummaries(root, 'pending', fs);
    expect(summaries.length).toBe(1);
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(true);

    // Phase 1230 Step B: async InboxWriter preserves caller-owned envelope id.
    const summaryPath = path.join(root, 'motion/inbox/pending', summaries[0]);
    const summaryContent = await fsAsync.readFile(summaryPath, 'utf-8');
    const decoded = decodeInbox(summaryContent);
    expect(decoded.id).toMatch(/^claw-outbox-summary-[0-9a-f]+-\d+$/);

    // Phase 1259 Step A: writer 只经 owner codec 写 v1 精确五字段 metadata —
    // 旧 `hash`（与 summary-hash 重复的双源）/ `failed_claws` / `incomplete` 退役。
    // （decodeInbox 将非 base key 归入 metadata pass-through。）
    expect(decoded.metadata).toEqual({
      guidance_schema_version: '1',
      'summary-hash': expect.stringMatching(/^[0-9a-f]{12}$/),
      counts: JSON.stringify({ clawA: 1 }),
      total_claws: '1',
      total_msgs: '1',
    });
    // decode 回来的 typed state 与 scan state 一致（round-trip 回归）。
    const state = decodeOutboxSummaryGuidance({
      type: decoded.type,
      from: decoded.from,
      meta: decoded.metadata!,
    });
    expect(state.counts).toEqual({ clawA: 1 });
    expect(state.totalClaws).toBe(1);
    expect(state.totalMsgs).toBe(1);
  });

  it('re-tick same state → skip silently (pending hit)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const firstSummary = (await listSummaries(root, 'pending', fs))[0];
    events.length = 0;
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect((await listSummaries(root, 'pending', fs))[0]).toBe(firstSummary);
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' || e[0] === 'cron_outbox_summary_cleared')).toBe(false);
  });

  it('after motion drain/ack re-tick → skip silently (done hit within 24h)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
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
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toEqual([]);
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' || e[0] === 'cron_outbox_summary_cleared')).toBe(false);
  });

  it('re-tick after markDone prefix → skip silently via extraMeta (not filename pattern)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
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
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' || e[0] === 'cron_outbox_summary_cleared')).toBe(false);
  });

  it('done file aged > 24h → write new (mtime window expired)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
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
      clawTopology: topology,
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
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const firstSummary = (await listSummaries(root, 'pending', fs))[0];

    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m2.md'), encodeOutbox(makeMsg('m2', '2026-06-04T10:00:01Z')));
    events.length = 0;
    await runOutboxSummaryTick({
      clawTopology: topology,
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

  it('all unread consumed + new tick → no write, no audit, old summary stays pending', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
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
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toContain(summary);
    expect(events.some(e => e[0] === 'cron_outbox_summary_skipped' || e[0] === 'cron_outbox_summary_cleared')).toBe(false);
  });

  it('phase 939: throws and audits when scan is incomplete', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), encodeOutbox(makeMsg('a1', '2026-06-04T10:00:00Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), encodeOutbox(makeMsg('b1', '2026-06-04T10:00:00Z')));

    const failingReader = {
      listClawOutboxPending: async (clawDir: string) => {
        const clawId = path.basename(clawDir);
        if (clawId === 'clawB') throw new Error('mock I/O failure');
        return outboxReader.listClawOutboxPending(clawDir);
      },
      peekLastOutboxPending: async (clawDir: string) => {
        const clawId = path.basename(clawDir);
        if (clawId === 'clawB') throw new Error('mock I/O failure');
        return outboxReader.peekLastOutboxPending(clawDir);
      },
    } as unknown as OutboxReader;

    await expect(
      runOutboxSummaryTick({
        clawTopology: topology,
        fs,
        inboxReader,
        inboxWriter,
        outboxReader: failingReader,
        audit,
      }),
    ).rejects.toThrow(/incomplete/i);

    expect(await listSummaries(root, 'pending', fs)).toHaveLength(0);
    expect(events.some(e => e[0] === 'cron_outbox_summary_failed' && e[1] === 'reason=scan_incomplete')).toBe(true);
  });

  it('phase 939: throws and audits when all claw scans fail', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });

    const failingReader = {
      listClawOutboxPending: async () => {
        throw new Error('mock I/O failure');
      },
      peekLastOutboxPending: async () => {
        throw new Error('mock I/O failure');
      },
    } as unknown as OutboxReader;

    await expect(
      runOutboxSummaryTick({
        clawTopology: topology,
        fs,
        inboxReader,
        inboxWriter,
        outboxReader: failingReader,
        audit,
      }),
    ).rejects.toThrow(/incomplete/i);

    expect(await listSummaries(root, 'pending', fs)).toHaveLength(0);
    expect(events.some(e => e[0] === 'cron_outbox_summary_failed' && e[1] === 'reason=scan_incomplete')).toBe(true);
  });

  it('phase 938: abort before scan throws and writes nothing', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));

    const controller = new AbortController();
    controller.abort();

    await expect(
      runOutboxSummaryTick({
        clawTopology: topology,
        fs,
        inboxReader,
        inboxWriter,
        outboxReader,
        audit,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(await listSummaries(root, 'pending', fs)).toEqual([]);
  });

  it('phase 938: abort after dedup before write throws and writes nothing', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));

    // First tick writes summary for hash A.
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    expect(await listSummaries(root, 'pending', fs)).toHaveLength(1);

    // Change state so dedup misses, then abort before write.
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m2.md'), encodeOutbox(makeMsg('m2', '2026-06-04T10:00:01Z')));
    const controller = new AbortController();

    const interceptReader = {
      listClawOutboxPending: async (clawDir: string) => {
        const files = await outboxReader.listClawOutboxPending(clawDir);
        // Abort after dedup scan returns (signal is checked right after scan).
        controller.abort();
        return files;
      },
      peekLastOutboxPending: outboxReader.peekLastOutboxPending.bind(outboxReader),
    } as unknown as OutboxReader;

    events.length = 0;
    await expect(
      runOutboxSummaryTick({
        clawTopology: topology,
        fs,
        inboxReader,
        inboxWriter,
        outboxReader: interceptReader,
        audit,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);

    // Only the first summary should exist.
    expect(await listSummaries(root, 'pending', fs)).toHaveLength(1);
  });

  it('phase 1749: repeat after done window expiry → body carries outbox-skip guidance', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), encodeOutbox(makeMsg('b1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const drained = await inboxReader.drainAndDeliver();
    expect(drained.handles.length).toBe(1);
    await inboxReader.ack(drained.handles[0]);
    const doneFiles = await fsAsync.readdir(path.join(root, 'motion/inbox/done'));
    const old = Date.now() - DEDUP_DONE_WINDOW_MS - 60_000;
    await fsAsync.utimes(path.join(root, 'motion/inbox/done', doneFiles[0]), old / 1000, old / 1000);

    events.length = 0;
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summaries = await listSummaries(root, 'pending', fs);
    expect(summaries).toHaveLength(1);
    expect(events.some(e => e[0] === 'cron_outbox_summary_written')).toBe(true);

    const summaryContent = await fsAsync.readFile(path.join(root, 'motion/inbox/pending', summaries[0]), 'utf-8');
    const body = decodeInbox(summaryContent).content;
    expect(body).toContain('〔提示〕以上未读消息与此前推送完全重复');
    expect(body).toContain('chestnut claw clawA outbox-skip --all');
    expect(body).toContain('chestnut claw clawB outbox-skip --all');
    // 逐 claw 命令按 claw id localeCompare 排序（与 body 行列表同序）
    expect(body.indexOf('chestnut claw clawA')).toBeLessThan(body.indexOf('chestnut claw clawB'));
    // hash 不变：extraMeta 与 body 解耦，dedup 语义不受影响
    const decoded = decodeInbox(summaryContent);
    expect(decoded.metadata).toEqual({
      guidance_schema_version: '1',
      'summary-hash': expect.stringMatching(/^[0-9a-f]{12}$/),
      counts: JSON.stringify({ clawA: 1, clawB: 1 }),
      total_claws: '2',
      total_msgs: '2',
    });
  });

  it('phase 1749: first push → body has no skip guidance', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summaries = await listSummaries(root, 'pending', fs);
    expect(summaries).toHaveLength(1);
    const body = decodeInbox(await fsAsync.readFile(path.join(root, 'motion/inbox/pending', summaries[0]), 'utf-8')).content;
    expect(body).not.toContain('〔提示〕');
    expect(body).not.toContain('outbox-skip');
  });

  it('phase 1749: new-hash push (state change, old summary pending) → new body has no guidance', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const firstSummary = (await listSummaries(root, 'pending', fs))[0];

    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m2.md'), encodeOutbox(makeMsg('m2', '2026-06-04T10:00:01Z')));
    events.length = 0;
    await runOutboxSummaryTick({
      clawTopology: topology,
      fs,
      inboxReader,
      inboxWriter,
      outboxReader,
      audit,
    });
    const summaries = await listSummaries(root, 'pending', fs);
    expect(summaries).toHaveLength(2);
    const newSummary = summaries.find(s => s !== firstSummary)!;
    const body = decodeInbox(await fsAsync.readFile(path.join(root, 'motion/inbox/pending', newSummary), 'utf-8')).content;
    expect(body).not.toContain('〔提示〕');
    expect(body).not.toContain('outbox-skip');
  });
});
