/**
 * Migration test: legacy uuid8 filenames remain readable after Phase 1230
 * switches writers to message-identity filenames.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createInboxWriter, createInboxReader, MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';


describe('migration: legacy uuid8 filenames remain readable (Phase 1230)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  const audit = { write: () => {} };

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `uuid8-migration-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('inbox reader can read legacy uuid8 filename', async () => {
    const pendingDir = path.join(testDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const legacyFile = `sender-000000123456789_high_${randomUUID().slice(0, 8)}.md`;
    const legacyContent = `---\nid: legacy-1\ntype: message\nfrom: sender\nto: claw\npriority: high\ntimestamp: 2024-01-01T00:00:00.000Z\n---\n\nLegacy body`;
    await fs.writeFile(path.join(pendingDir, legacyFile), legacyContent, 'utf-8');

    const reader = createInboxReader(nfs, audit as any, testDir);
    const { entries } = await reader.drainInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].message.content).toBe('Legacy body');
    expect(entries[0].message.priority).toBe('high');
  });

  it('outbox reader can read legacy uuid8 filename', async () => {
    const pendingDir = path.join(testDir, 'outbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const legacyFile = `1234567890123_report_${randomUUID().slice(0, 8)}.md`;
    const legacyContent = `---\nid: legacy-ob-1\ntype: report\nfrom: claw-a\nto: claw-b\ncontent: Legacy outbox\npriority: normal\ntimestamp: 2024-01-01T00:00:00.000Z\n---\n\nLegacy outbox body`;
    await fs.writeFile(path.join(pendingDir, legacyFile), legacyContent, 'utf-8');

    const { createOutboxReader } = await import('../../../src/foundation/messaging/outbox-reader.js');
    const reader = createOutboxReader({ clawRoot: testDir, fs: nfs, audit });
    const latest = await reader.peekLastOutboxPending();
    // phase 1784: typed peek outcome
    expect(latest.kind).toBe('found');
    if (latest.kind !== 'found') throw new Error('unreachable');
    expect(latest.message.content).toBe('Legacy outbox body');
  });

  it('new writer filename does not collide with legacy uuid8 filename', async () => {
    const pendingDir = path.join(testDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const legacyFile = `sender-000000123456789_high_${randomUUID().slice(0, 8)}.md`;
    await fs.writeFile(path.join(pendingDir, legacyFile), 'legacy', 'utf-8');

    const writer = createInboxWriter(nfs, testDir, audit as any, MESSAGING_WRITER_LIMITS_DEFAULT);
    const msg: InboxMessage = {
      id: 'new-1', type: 'message', from: 'sender', to: 'claw',
      content: 'New', priority: 'high', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);

    const files = await fs.readdir(pendingDir);
    expect(files).toHaveLength(2);
    expect(files).toContain(legacyFile);
  });
});
