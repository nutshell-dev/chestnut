/**
 * InboxWriter class tests
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

describe('InboxWriter', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: string[];
  let writer: InboxWriter;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `inbox-writer-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push(`${type}:${cols.join(',')}`);
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // ─── .write() ────────────────────────────────────────────────────────────

  it('write creates a file with correct frontmatter', async () => {
    const msg: InboxMessage = {
      id: 'test-1',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Hello',
      priority: 'high',
      timestamp: new Date().toISOString(),
    };

    await writer.write(msg);

    const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^sender-\d+_high_[a-f0-9-]+\.md$/);
  });

  it('write audits INBOX_WRITTEN on success', async () => {
    const msg: InboxMessage = {
      id: 'test-1', type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);
    expect(auditCalls.some(c => c.startsWith('inbox_written:'))).toBe(true);
  });

  it('write audits INBOX_WRITE_FAILED and throws on failure', async () => {
    // Make directory read-only to force write failure
    const pendingDir = path.join(testDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.chmod(pendingDir, 0o555);

    const msg: InboxMessage = {
      id: 'test-1', type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };

    try {
      await expect(writer.write(msg)).rejects.toThrow();
      expect(auditCalls.some(c => c.startsWith('inbox_write_failed:'))).toBe(true);
    } finally {
      await fs.chmod(pendingDir, 0o755);
    }
  });

  // ─── .writeSync() ────────────────────────────────────────────────────────

  it('writeSync creates a file with correct frontmatter', () => {
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

  it('writeSync audits INBOX_WRITTEN on success', () => {
    writer.writeSync({ type: 'ping', source: 'motion', priority: 'normal', body: 'test' });
    expect(auditCalls.some(c => c.startsWith('inbox_written:'))).toBe(true);
  });

  // ─── .readMeta() ─────────────────────────────────────────────────────────

  it('readMeta returns ok with meta for valid file', async () => {
    const msg: InboxMessage = {
      id: 'meta-test', type: 'message', from: 's', to: 'c',
      content: 'Body', priority: 'critical', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);

    const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    const result = InboxWriter.readMeta(nfs, path.join(testDir, 'inbox', 'pending', files[0]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('message');
      expect(result.value.priority).toBe('critical');
    }
  });

  it('readMeta returns err(not_found) for missing file', () => {
    const result = InboxWriter.readMeta(nfs, path.join(testDir, 'inbox', 'pending', 'missing.md'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not_found');
    }
  });

  it('readMeta returns err(parse_failed) for malformed frontmatter', async () => {
    const badFile = path.join(testDir, 'bad.md');
    await fs.writeFile(badFile, '---\nno closing', 'utf-8');
    const result = InboxWriter.readMeta(nfs, badFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('parse_failed');
    }
  });
});
