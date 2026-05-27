/**
 * Phase 1046: InboxReader taskId dedupe reverse tests
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
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';

describe('InboxReader taskId dedupe', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-dedupe-${randomUUID()}`);
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

  // ─── Case 1: 双 inbox same task → 1 read（去重）──────────────────────────
  it('dedupes duplicate taskId in same batch', async () => {
    const taskId = 'task-dedupe-1';
    const content1 = JSON.stringify({ taskId, result: 'result-a' });
    const content2 = JSON.stringify({ taskId, result: 'result-b' });

    await writer.write({
      id: 'msg-1',
      type: 'result',
      from: 'sender',
      to: 'claw',
      content: content1,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    await writer.write({
      id: 'msg-2',
      type: 'result',
      from: 'sender',
      to: 'claw',
      content: content2,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    const results = await reader.drainInbox();

    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].message.content).taskId).toBe(taskId);

    // second message moved to done/
    const doneFiles = await fs.readdir(path.join(testDir, 'inbox', 'done'));
    expect(doneFiles).toHaveLength(1);

    // audit emit INBOX_DEDUPED 1 次
    const dedupeAudits = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED);
    expect(dedupeAudits).toHaveLength(1);
    expect(dedupeAudits[0].cols.some(c => c.includes(`taskId=${taskId}`))).toBe(true);
  });

  // ─── Case 2: single inbox → 1 read（不去重）──────────────────────────────
  it('passes single message through', async () => {
    const taskId = 'task-single-1';
    const content = JSON.stringify({ taskId, result: 'result-only' });

    await writer.write({
      id: 'msg-1',
      type: 'result',
      from: 'sender',
      to: 'claw',
      content,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    const results = await reader.drainInbox();

    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].message.content).taskId).toBe(taskId);

    // no dedupe audit
    const dedupeAudits = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED);
    expect(dedupeAudits).toHaveLength(0);
  });

  // ─── Case 3: different task → 2 read（不去重）────────────────────────────
  it('keeps different taskIds', async () => {
    const taskIdA = 'task-diff-a';
    const taskIdB = 'task-diff-b';

    await writer.write({
      id: 'msg-a',
      type: 'result',
      from: 'sender',
      to: 'claw',
      content: JSON.stringify({ taskId: taskIdA, result: 'result-a' }),
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    await writer.write({
      id: 'msg-b',
      type: 'result',
      from: 'sender',
      to: 'claw',
      content: JSON.stringify({ taskId: taskIdB, result: 'result-b' }),
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    const results = await reader.drainInbox();

    expect(results).toHaveLength(2);
    const taskIds = results.map(r => JSON.parse(r.message.content).taskId);
    expect(taskIds).toContain(taskIdA);
    expect(taskIds).toContain(taskIdB);

    // no dedupe audit
    const dedupeAudits = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED);
    expect(dedupeAudits).toHaveLength(0);
  });

  // ─── Case 4: non-JSON content skips dedupe ──────────────────────────────
  it('skips dedupe for non-JSON content', async () => {
    await writer.write({
      id: 'msg-1',
      type: 'user_chat',
      from: 'sender',
      to: 'claw',
      content: 'plain text not json',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    await writer.write({
      id: 'msg-2',
      type: 'user_chat',
      from: 'sender',
      to: 'claw',
      content: 'another plain text',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });

    const results = await reader.drainInbox();

    expect(results).toHaveLength(2);

    const dedupeAudits = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED);
    expect(dedupeAudits).toHaveLength(0);
  });
});
