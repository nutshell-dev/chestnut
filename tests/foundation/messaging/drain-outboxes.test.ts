import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { drainOutboxes } from '../../../src/foundation/messaging/drain-outboxes.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';

describe('phase 1333 drainOutboxes Messaging write-side encap', () => {
  let testDir: string;
  let clawforumDir: string;
  let fsNfs: NodeFileSystem;
  let auditCalls: string[];

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `drain-outboxes-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    clawforumDir = path.join(testDir, 'clawforum');
    await fs.mkdir(clawforumDir, { recursive: true });
    fsNfs = new NodeFileSystem({ baseDir: clawforumDir });
    auditCalls = [];
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeAudit() {
    return {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push(`${type}:${cols.join(',')}`);
      },
    };
  }

  async function writeOutboxMsg(clawId: string, msg: OutboxMessage) {
    const outboxPending = path.join(clawforumDir, 'claws', clawId, 'outbox', 'pending');
    await fs.mkdir(outboxPending, { recursive: true });
    const fileName = `${msg.id}.md`;
    await fs.writeFile(path.join(outboxPending, fileName), encodeOutbox(msg), 'utf-8');
  }

  it('drain 1 claw 1 msg → InboxWriter codec 走 + audit emit', async () => {
    const clawId = 'claw-a';
    const msg: OutboxMessage = {
      id: 'msg-1',
      type: 'question',
      from: clawId,
      to: 'motion',
      content: 'hello motion',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'high',
    };
    await writeOutboxMsg(clawId, msg);

    const audit = makeAudit();
    const result = await drainOutboxes({ clawforumRoot: clawforumDir, fs: fsNfs, audit });

    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    // verify motion inbox received the file
    const motionInboxDir = path.join(clawforumDir, 'motion', 'inbox', 'pending');
    const inboxFiles = await fs.readdir(motionInboxDir);
    expect(inboxFiles.length).toBe(1);

    const inboxContent = await fs.readFile(path.join(motionInboxDir, inboxFiles[0]), 'utf-8');
    expect(inboxContent).toContain('type: question');
    expect(inboxContent).toContain('from: "claw-a"');
    expect(inboxContent).toContain('to: "motion"');
    expect(inboxContent).toContain('hello motion');

    // verify audit emit (InboxWriter writes INBOX_WRITTEN)
    const inboxWritten = auditCalls.filter(c => c.startsWith('inbox_written:'));
    expect(inboxWritten.length).toBe(1);

    // verify outbox file moved to done
    const doneDir = path.join(clawforumDir, 'claws', clawId, 'outbox', 'done');
    const doneFiles = await fs.readdir(doneDir);
    expect(doneFiles.length).toBe(1);
  });

  it('atomic claim race N=10 simulate winner-takes-all', async () => {
    const clawId = 'claw-race';
    const msg: OutboxMessage = {
      id: 'race-msg',
      type: 'report',
      from: clawId,
      to: 'motion',
      content: 'race content',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
    };
    await writeOutboxMsg(clawId, msg);

    const audit = makeAudit();
    const promises = Array.from({ length: 10 }, () =>
      drainOutboxes({ clawforumRoot: clawforumDir, fs: fsNfs, audit }),
    );
    const results = await Promise.all(promises);

    const totalDelivered = results.reduce((sum, r) => sum + r.delivered, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

    // exactly 1 winner delivers, rest lose race or see empty pending
    expect(totalDelivered).toBe(1);

    // verify only 1 inbox file exists
    const motionInboxDir = path.join(clawforumDir, 'motion', 'inbox', 'pending');
    const inboxFiles = await fs.readdir(motionInboxDir);
    expect(inboxFiles.length).toBe(1);

    // verify exactly 1 done file
    const doneDir = path.join(clawforumDir, 'claws', clawId, 'outbox', 'done');
    const doneFiles = await fs.readdir(doneDir);
    expect(doneFiles.length).toBe(1);
  });

  it('跨 claw routing by `to:` field destination 分流', async () => {
    const clawA = 'claw-a';
    const clawB = 'claw-b';

    await writeOutboxMsg(clawA, {
      id: 'to-motion',
      type: 'question',
      from: clawA,
      to: 'motion',
      content: 'for motion',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
    });

    await writeOutboxMsg(clawB, {
      id: 'to-clawA',
      type: 'response',
      from: clawB,
      to: clawA,
      content: 'for clawA',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'high',
    });

    const audit = makeAudit();
    const result = await drainOutboxes({ clawforumRoot: clawforumDir, fs: fsNfs, audit });

    expect(result.delivered).toBe(2);

    // motion inbox should have 1 file
    const motionInboxDir = path.join(clawforumDir, 'motion', 'inbox', 'pending');
    const motionFiles = await fs.readdir(motionInboxDir);
    expect(motionFiles.length).toBe(1);

    // clawA inbox should have 1 file
    const clawAInboxDir = path.join(clawforumDir, 'claws', clawA, 'inbox', 'pending');
    const clawAFiles = await fs.readdir(clawAInboxDir);
    expect(clawAFiles.length).toBe(1);

    const clawAContent = await fs.readFile(path.join(clawAInboxDir, clawAFiles[0]), 'utf-8');
    expect(clawAContent).toContain('for clawA');
  });

  it('limitPerClaw bomb defense', async () => {
    const clawId = 'claw-bomb';
    for (let i = 0; i < 100; i++) {
      await writeOutboxMsg(clawId, {
        id: `msg-${i}`,
        type: 'report',
        from: clawId,
        to: 'motion',
        content: `body ${i}`,
        timestamp: '2026-05-26T12:00:00.000Z',
        priority: 'normal',
      });
    }

    const audit = makeAudit();
    const result = await drainOutboxes({ clawforumRoot: clawforumDir, fs: fsNfs, audit, limitPerClaw: 5 });

    expect(result.delivered).toBe(5);

    // motion inbox should have exactly 5 files
    const motionInboxDir = path.join(clawforumDir, 'motion', 'inbox', 'pending');
    const motionFiles = await fs.readdir(motionInboxDir);
    expect(motionFiles.length).toBe(5);

    // 95 remain in pending
    const pendingDir = path.join(clawforumDir, 'claws', clawId, 'outbox', 'pending');
    const pendingFiles = await fs.readdir(pendingDir);
    expect(pendingFiles.length).toBe(95);
  });

  it('signal abort mid-loop graceful exit', async () => {
    const clawId = 'claw-abort';
    for (let i = 0; i < 10; i++) {
      await writeOutboxMsg(clawId, {
        id: `abort-${i}`,
        type: 'report',
        from: clawId,
        to: 'motion',
        content: `body ${i}`,
        timestamp: '2026-05-26T12:00:00.000Z',
        priority: 'normal',
      });
    }

    const abortController = new AbortController();
    const audit = makeAudit();

    // abort after a short delay to allow partial delivery
    setTimeout(() => abortController.abort(), 10);

    const result = await drainOutboxes({
      clawforumRoot: clawforumDir,
      fs: fsNfs,
      audit,
      signal: abortController.signal,
    });

    // should have delivered some (possibly 0 or 1 depending on timing) and not all 10
    expect(result.delivered).toBeLessThan(10);
    expect(result.delivered + result.failed).toBeLessThan(10);
  });
});
