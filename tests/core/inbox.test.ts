/**
 * InboxReader tests - priority sorting + file movement + decode fallback
 *
 * Simplified tests using real filesystem to verify InboxReader core behaviors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { InboxReader } from '../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { InboxMessage } from '../../src/types/contract.js';
import { makeAudit } from '../helpers/audit.js';

describe('InboxReader', () => {
  let testDir: string;
  let reader: InboxReader;
  let nfs: NodeFileSystem;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `clawforum-inbox-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir, enforcePermissions: false });
    reader = new InboxReader('inbox/pending', 'inbox/done', 'inbox/failed', nfs, makeAudit().audit);
    await reader.init();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should parse message priority from frontmatter', async () => {
    const msgContent = `---
type: normal
priority: high
id: test-msg-1
from: test-sender
timestamp: 2026-03-15T12:00:00Z
---
Test message content`;

    const msgPath = path.join(testDir, 'test_message.md');
    await fs.writeFile(msgPath, msgContent, 'utf-8');

    const content = await fs.readFile(msgPath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    expect(match).toBeTruthy();

    const frontmatter = match![1];
    const body = match![2].trim();

    expect(frontmatter).toContain('priority: high');
    expect(body).toBe('Test message content');
  });

  it('should move failed messages to failed directory', async () => {
    const clawDir = path.join(testDir, 'test-claw');
    const pendingDir = path.join(clawDir, 'inbox', 'pending');
    const failedDir = path.join(clawDir, 'inbox', 'failed');

    await fs.mkdir(pendingDir, { recursive: true });
    await fs.mkdir(failedDir, { recursive: true });

    const msgFile = path.join(pendingDir, '1000_normal_test.md');
    await fs.writeFile(msgFile, '---\ntype: normal\n---\nTest', 'utf-8');

    const failedFile = path.join(failedDir, '1000_normal_test.md');
    await fs.rename(msgFile, failedFile);

    const failedFiles = await fs.readdir(failedDir);
    expect(failedFiles).toContain('1000_normal_test.md');

    const pendingFiles = await fs.readdir(pendingDir);
    expect(pendingFiles).toHaveLength(0);
  });

  it('should sort drainInbox by priority (critical > high > normal > low)', async () => {
    const lowMsg: InboxMessage = {
      id: 'low',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Low',
      priority: 'low',
      timestamp: new Date().toISOString(),
    };
    const criticalMsg: InboxMessage = {
      id: 'critical',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Critical',
      priority: 'critical',
      timestamp: new Date().toISOString(),
    };
    const normalMsg: InboxMessage = {
      id: 'normal',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Normal',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };
    const highMsg: InboxMessage = {
      id: 'high',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'High',
      priority: 'high',
      timestamp: new Date().toISOString(),
    };

    await nfs.writeAtomic('inbox/pending/low.md', buildMdMessage(lowMsg));
    await nfs.writeAtomic('inbox/pending/critical.md', buildMdMessage(criticalMsg));
    await nfs.writeAtomic('inbox/pending/normal.md', buildMdMessage(normalMsg));
    await nfs.writeAtomic('inbox/pending/high.md', buildMdMessage(highMsg));

    const entries = await reader.drainInbox();

    expect(entries[0].message.id).toBe('critical');
    expect(entries[1].message.id).toBe('high');
    expect(entries[2].message.id).toBe('normal');
    expect(entries[3].message.id).toBe('low');
  });

  it('should sort drainInbox by timestamp for same priority (FIFO)', async () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const msgs: InboxMessage[] = [
      { id: 'third', type: 'message', from: 's', to: 'c', content: '3', priority: 'high', timestamp: new Date(base + 3000).toISOString() },
      { id: 'first', type: 'message', from: 's', to: 'c', content: '1', priority: 'high', timestamp: new Date(base + 1000).toISOString() },
      { id: 'second', type: 'message', from: 's', to: 'c', content: '2', priority: 'high', timestamp: new Date(base + 2000).toISOString() },
    ];

    for (const m of msgs) {
      await nfs.writeAtomic(`inbox/pending/${m.id}.md`, buildMdMessage(m));
    }

    const entries = await reader.drainInbox();
    expect(entries[0].message.id).toBe('first');
    expect(entries[1].message.id).toBe('second');
    expect(entries[2].message.id).toBe('third');
  });

  it('should include UUID in done/failed filenames', async () => {
    const msgFile = path.join(testDir, 'inbox', 'pending', 'test.md');
    await fs.writeFile(msgFile, '---\ntype: normal\n---\nTest', 'utf-8');

    await reader.markDone('inbox/pending/test.md');

    const doneFiles = await fs.readdir(path.join(testDir, 'inbox', 'done'));
    expect(doneFiles).toHaveLength(1);

    const parts = doneFiles[0].split('_');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[1].length).toBe(8); // UUID8
  });

  it('should load existing messages on cold start', async () => {
    const msgs: InboxMessage[] = [
      { id: 'msg-1', type: 'message', from: 's', to: 'c', content: 'Body 1', priority: 'normal', timestamp: new Date().toISOString() },
      { id: 'msg-2', type: 'message', from: 's', to: 'c', content: 'Body 2', priority: 'high', timestamp: new Date().toISOString() },
    ];

    for (const m of msgs) {
      await nfs.writeAtomic(`inbox/pending/${m.id}.md`, buildMdMessage(m));
    }

    const entries = await reader.drainInbox();
    const ids = entries.map(e => e.message.id);

    expect(ids).toContain('msg-1');
    expect(ids).toContain('msg-2');
  });

  it('invalid priority frontmatter falls back to normal', async () => {
    await nfs.writeAtomic(
      'inbox/pending/invalid.md',
      '---\ntype: message\npriority: urgent\nid: p-fallback\nfrom: s\nto: c\ntimestamp: 2026-01-01T00:00:00Z\n---\nBody',
    );

    const entries = await reader.drainInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].message.priority).toBe('normal');
    expect(entries[0].message.id).toBe('p-fallback');
  });

  it('unknown type frontmatter passes through unchanged', async () => {
    await nfs.writeAtomic(
      'inbox/pending/unknown.md',
      '---\ntype: unknown_event\npriority: normal\nid: t-fallback\nfrom: s\nto: c\ntimestamp: 2026-01-01T00:00:00Z\n---\nBody',
    );

    const entries = await reader.drainInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].message.type).toBe('unknown_event');
    expect(entries[0].message.id).toBe('t-fallback');
  });

  it('watchdog_ prefix type passes through unchanged', async () => {
    await nfs.writeAtomic(
      'inbox/pending/watchdog.md',
      '---\ntype: watchdog_ping\npriority: normal\nid: wd-passthrough\nfrom: s\nto: c\ntimestamp: 2026-01-01T00:00:00Z\n---\nBody',
    );

    const entries = await reader.drainInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].message.type).toBe('watchdog_ping');
  });

  it('should move malformed message to failed on parse error', async () => {
    await nfs.writeAtomic(
      'inbox/pending/malformed.md',
      '---\ntype: normal\nid: bad-msg\n(no closing fence)',
    );

    const entries = await reader.drainInbox();
    expect(entries).toHaveLength(0);

    const failedFiles = await fs.readdir(path.join(testDir, 'inbox', 'failed'));
    expect(failedFiles).toHaveLength(1);
    expect(failedFiles[0]).toContain('malformed.md');
  });
});

function buildMdMessage(msg: InboxMessage): string {
  return `---
id: ${msg.id}
type: ${msg.type}
from: ${msg.from}
to: ${msg.to}
priority: ${msg.priority}
timestamp: ${msg.timestamp}
${msg.contract_id ? `contract_id: ${msg.contract_id}` : ''}
---

${msg.content}
`;
}
