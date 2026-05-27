/**
 * Inbox filename source prefix tests (phase 1047)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';

describe('inbox filename source prefix (phase 1047)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-prefix-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    const audit = { write: () => {} };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit as any);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('write() filename contains source prefix from msg.from', async () => {
    const msg: InboxMessage = {
      id: 'test-1',
      type: 'message',
      from: 'claw-a',
      to: 'claw-b',
      content: 'Hello',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };

    await writer.write(msg);

    const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claw-a-\d{15}_normal_[a-f0-9]+\.md$/);
  });

  it('writeSync() filename contains source prefix from opts.source', () => {
    writer.writeSync({
      type: 'ping',
      source: 'motion',
      priority: 'high',
      body: 'test body',
    });

    const files = fsSync.readdirSync(path.join(testDir, 'inbox', 'pending'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^motion-\d{15}_high_[a-f0-9]+\.md$/);
  });
});
