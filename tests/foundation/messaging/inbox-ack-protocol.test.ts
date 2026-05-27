/**
 * Phase 1285: InboxReader ack/nack/reconcile protocol reverse tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../../src/foundation/messaging/dirs.js';

describe('InboxReader ack/nack/reconcile protocol (phase 1285)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-ack-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push({ type, cols: cols.map(String) });
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit);
    reader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await reader.init();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeMsg(id: string, body: string) {
    await writer.write({
      id,
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: body,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Case 1: drainAndDeliver moves files to inflight ──────────────────────
  it('drainAndDeliver moves pending files to inflight/', async () => {
    await writeMsg('msg-1', 'hello');

    const { entries, handles } = await reader.drainAndDeliver();

    expect(entries).toHaveLength(1);
    expect(handles).toHaveLength(1);
    expect(path.basename(handles[0].filePath)).toBe(path.basename(entries[0].filePath));
    expect(handles[0].filePath).toContain('/inflight/');

    const pendingFiles = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(1);
  });

  // ─── Case 2: ack moves inflight to done ───────────────────────────────────
  it('ack moves inflight file to done/', async () => {
    await writeMsg('msg-1', 'hello');
    const { handles } = await reader.drainAndDeliver();

    await reader.ack(handles[0]);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(0);

    const doneFiles = await fs.readdir(path.join(testDir, 'inbox', 'done'));
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toMatch(/^\d+_[a-f0-9]{8}_.+\.md$/);
  });

  // ─── Case 3: nack moves inflight back to pending ──────────────────────────
  it('nack moves inflight file back to pending/', async () => {
    await writeMsg('msg-1', 'hello');
    const { handles } = await reader.drainAndDeliver();

    await reader.nack(handles[0], 'user_interrupt');

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(0);

    const pendingFiles = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(1);

    const nackAudit = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_NACK);
    expect(nackAudit).toHaveLength(1);
    expect(nackAudit[0].cols.some(c => c.includes('reason=user_interrupt'))).toBe(true);
  });

  // ─── Case 4: init reconcile inflight→pending on startup ───────────────────
  it('init() reconciles orphaned inflight files back to pending', async () => {
    await writeMsg('msg-1', 'hello');
    // manually move to inflight to simulate crash before ack
    const src = path.join(testDir, 'inbox', 'pending');
    const dst = path.join(testDir, 'inbox', 'inflight');
    const files = await fs.readdir(src);
    for (const f of files) {
      await fs.rename(path.join(src, f), path.join(dst, f));
    }

    // create new reader → init() should reconcile
    const freshAuditCalls: Array<{ type: string; cols: string[] }> = [];
    const freshAudit = {
      write(type: string, ...cols: (string | number)[]) {
        freshAuditCalls.push({ type, cols: cols.map(String) });
      },
    };
    const freshReader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      freshAudit,
    );
    await freshReader.init();

    const pendingFiles = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(1);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(0);

    const reconcileAudit = freshAuditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RECONCILE);
    expect(reconcileAudit).toHaveLength(1);
    expect(reconcileAudit[0].cols.some(c => c.includes('reverted_count=1'))).toBe(true);
  });

  // ─── Case 5: drainAndDeliver on empty inbox returns empty ─────────────────
  it('drainAndDeliver on empty pending returns empty', async () => {
    const { entries, handles } = await reader.drainAndDeliver();
    expect(entries).toHaveLength(0);
    expect(handles).toHaveLength(0);
  });
});
