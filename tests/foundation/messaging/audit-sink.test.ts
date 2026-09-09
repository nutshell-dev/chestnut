/**
 * phase 1824 (concrete-auditlog-dependency):
 * Messaging 各审计入口只要求一个结构化 write 能力（MessagingAuditSink），
 * 不带品牌/格式化/生命周期能力的真实单方法对象必须能直接穿过
 * reader/writer/factory 与通知入口；事件列、持久化和失败路径保持既有契约。
 * 不使用 vi.mock、不使用 as AuditLog/any/unknown 绕过。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as disk } from 'node:fs';
import * as path from 'node:path';
import {
  InboxWriter,
  OutboxReader,
  createInboxReader,
  createOutboxWriter,
  makeInboxPath,
  notifyClaw,
  notifyInbox,
  writeInboxAsync,
  MESSAGING_AUDIT_EVENTS,
  MESSAGING_WRITER_LIMITS_DEFAULT,
} from '../../../src/foundation/messaging/index.js';
import { makeClawId } from '../../../src/foundation/claw-identity/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileEntry } from '../../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

type SinkRow = [string, ...(string | number)[]];

function makeSink(rows: SinkRow[]): { write(type: string, ...cols: (string | number)[]): void } {
  return {
    write(type: string, ...cols: (string | number)[]): void {
      rows.push([type, ...cols]);
    },
  };
}

/** 只让 list 抛同一 Error 对象的真实 fs（其余 I/O 不变） */
class ListFailFs extends NodeFileSystem {
  readonly failure = new Error('list denied');

  override async list(
    _relativePath: string,
    _options?: { recursive?: boolean; includeDirs?: boolean; pattern?: string },
  ): Promise<FileEntry[]> {
    throw this.failure;
  }
}

describe('Messaging accepts only the audit write capability', () => {
  let root: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    root = await createTempDir('chestnut-test-');
    fs = new NodeFileSystem({ baseDir: root });
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it('persists and reads messages with an unbranded write-only sink', async () => {
    const rows: SinkRow[] = [];
    const sink = makeSink(rows);
    const inbox = path.join(root, 'inbox');
    const pending = path.join(inbox, 'pending');

    notifyInbox(fs, { inboxDir: pending, type: 'text', source: 'a', body: 'sync' }, sink);
    await writeInboxAsync(fs, pending, {
      id: 'async-1', type: 'text', from: 'a', to: 'b', content: 'async',
      timestamp: new Date().toISOString(), priority: 'normal',
    }, sink);

    const reader = createInboxReader(fs, sink, inbox);
    expect((await reader.init()).kind).toBe('ready');
    const batch = await reader.drainAndDeliver();
    expect(batch.kind).toBe('complete');
    if (batch.kind !== 'complete') throw new Error('expected complete batch');
    expect(batch.entries.map(e => e.message.content).sort()).toEqual(['async', 'sync']);
    for (const handle of batch.handles) await reader.ack(handle);
    expect(await disk.readdir(path.join(inbox, 'done'))).toHaveLength(2);

    const writer = createOutboxWriter(makeClawId('claw-a'), root, fs, sink, MESSAGING_WRITER_LIMITS_DEFAULT);
    await writer.write({ type: 'report', to: 'motion', content: 'outbox' });
    const peek = await new OutboxReader(fs, sink).peekLastOutboxPending(root);
    expect(peek.kind).toBe('found');
    if (peek.kind !== 'found') throw new Error('expected persisted outbox message');
    expect(peek.message.content).toBe('outbox');

    notifyClaw(fs, root, pending, undefined, { type: 'text', source: 'a', body: 'cross' }, sink);
    expect(await disk.readdir(pending)).toHaveLength(1);
    expect(rows.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN)).toHaveLength(3);
    expect(rows.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.INBOX_DONE)).toHaveLength(2);
    expect(rows.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)).toHaveLength(1);
    expect(rows.find(r => r[0] === MESSAGING_AUDIT_EVENTS.OUTBOX_SENT)).toEqual([
      MESSAGING_AUDIT_EVENTS.OUTBOX_SENT, 'from=claw-a', 'to=motion', 'type=report', `id=${peek.message.id}`,
    ]);
  });

  it('reports outbox list failure with error identity and audit through the sink', async () => {
    const rows: SinkRow[] = [];
    const sink = makeSink(rows);
    const failingFs = new ListFailFs({ baseDir: root });
    const result = await new OutboxReader(failingFs, sink).peekLastOutboxPending(root);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed peek');
    expect(result.stage).toBe('list');
    expect(result.error).toBe(failingFs.failure);
    const pending = path.join(root, 'outbox', 'pending');
    expect(result.path).toBe(pending);
    expect(rows).toEqual([[
      MESSAGING_AUDIT_EVENTS.OUTBOX_PEEK_FAILED,
      `file=${pending}`,
      'stage=list',
      'reason=list denied',
    ]]);
  });

  it('accepts a write-only sink through direct writer construction', async () => {
    const rows: SinkRow[] = [];
    const sink = makeSink(rows);
    const pending = path.join(root, 'inbox', 'pending');
    const writer = InboxWriter.__internal_create(fs, makeInboxPath(pending), sink, MESSAGING_WRITER_LIMITS_DEFAULT);

    await writer.write({
      id: 'direct-async', type: 'text', from: 'a', to: 'b', content: 'direct-async-body',
      timestamp: new Date().toISOString(), priority: 'normal',
    });
    writer.writeSync({ type: 'text', source: 'c', to: 'd', body: 'direct-sync-body' });

    const files = await disk.readdir(pending);
    expect(files).toHaveLength(2);
    const contents = (await Promise.all(files.map(f => disk.readFile(path.join(pending, f), 'utf8')))).join('\n');
    expect(contents).toContain('direct-async-body');
    expect(contents).toContain('direct-sync-body');
    expect(rows.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN)).toHaveLength(2);
  });

  it('keeps invariants chain auditing through the sink without blocking the write', async () => {
    const rows: SinkRow[] = [];
    const sink = makeSink(rows);
    const pending = path.join(root, 'inbox', 'pending');
    const writer = InboxWriter.__internal_create(fs, makeInboxPath(pending), sink, MESSAGING_WRITER_LIMITS_DEFAULT);

    await writer.write({
      id: '', type: 'text', from: 'a', to: 'b', content: 'bad-id-body',
      timestamp: new Date().toISOString(), priority: 'normal',
    });

    const files = await disk.readdir(pending);
    expect(files).toHaveLength(1);
    const content = await disk.readFile(path.join(pending, files[0]), 'utf8');
    expect(content).toContain('bad-id-body');
    expect(rows).toContainEqual([
      MESSAGING_AUDIT_EVENTS.MESSAGING_MESSAGE_INVARIANT_VIOLATED,
      'kind=inbox',
      'direction=write',
      'sub_check=id_empty',
    ]);
    expect(rows.filter(r => r[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN)).toHaveLength(1);
  });
});
