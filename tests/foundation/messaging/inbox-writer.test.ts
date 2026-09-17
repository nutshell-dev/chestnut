/**
 * InboxWriter class tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';

const UUID_V4_RE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function extractUuid(filename: string): string | undefined {
  const match = filename.match(new RegExp(`(${UUID_V4_RE})\\.md$`, 'i'));
  return match?.[1];
}

describe('InboxWriter', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: string[];
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `inbox-writer-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push(`${type}:${cols.join(',')}`);
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  // ─── .write() ────────────────────────────────────────────────────────────

  it('write creates a file with correct frontmatter', async () => {
    const msg: InboxMessage = {
      id: `test-${randomUUID()}`,
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
    expect(files[0]).toMatch(new RegExp(`^sender-\\d{15}_high_${UUID_V4_RE}\\.md$`, 'i'));
  });

  it('write preserves caller-owned id and uses an independent UUID filename suffix', async () => {
    const callerId = `message-${randomUUID()}`;
    const msg: InboxMessage = {
      id: callerId,
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Hello',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };

    await writer.write(msg);

    const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(files).toHaveLength(1);
    const suffix = extractUuid(files[0]);
    expect(suffix).toBeDefined();
    expect(suffix).not.toBe(callerId);

    const content = await fs.readFile(path.join(testDir, 'inbox', 'pending', files[0]), 'utf-8');
    const decoded = decodeInbox(content);
    expect(decoded.id).toBe(callerId);
  });

  it('write does not mutate the input message object', async () => {
    const msg: InboxMessage = {
      id: 'legacy-caller-id',
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: 'Hello',
      priority: 'normal',
      timestamp: new Date().toISOString(),
    };
    const snapshot = structuredClone(msg);

    await writer.write(msg);

    expect(msg).toEqual(snapshot);

    const files = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    const content = await fs.readFile(path.join(testDir, 'inbox', 'pending', files[0]), 'utf-8');
    const decoded = decodeInbox(content);
    expect(decoded.id).toBe('legacy-caller-id');
  });

  it('write audits INBOX_WRITTEN on success', async () => {
    const msg: InboxMessage = {
      id: `test-${randomUUID()}`, type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);
    const written = auditCalls.find(c => c.startsWith('inbox_written:'));
    expect(written).toBeDefined();
    // phase 1851 Step B: messaging events record message identity only
    expect(written).toContain(`id=${msg.id}`);
    expect(written).toContain('type=message');
  });

  it('write audits INBOX_WRITE_FAILED and throws on failure', async () => {
    // Make directory read-only to force write failure
    const pendingDir = path.join(testDir, 'inbox', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.chmod(pendingDir, 0o555);

    const msg: InboxMessage = {
      id: `test-${randomUUID()}`, type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };

    try {
      await expect(writer.write(msg)).rejects.toThrow();
      const failed = auditCalls.find(c => c.startsWith('inbox_write_failed:'));
      expect(failed).toBeDefined();
      expect(failed).toContain(`id=${msg.id}`);
      expect(failed).toContain('type=message');
    } finally {
      await fs.chmod(pendingDir, 0o755);
    }
  });

  it('concurrent async writes with frozen timestamp produce distinct files and no overwrites', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890123);

    const writes = Array.from({ length: 5 }, (_, i) => {
      const msg: InboxMessage = {
        id: `test-${i}-${randomUUID()}`,
        type: 'message',
        from: 'sender',
        to: 'claw',
        content: `msg ${i}`,
        priority: 'normal',
        timestamp: new Date().toISOString(),
      };
      return writer.write(msg);
    });

    await expect(Promise.all(writes)).resolves.not.toThrow();

    const pendingDir = path.join(testDir, 'inbox', 'pending');
    const files = await fs.readdir(pendingDir);
    expect(files).toHaveLength(5);

    const suffixes = files.map(extractUuid);
    expect(new Set(suffixes).size).toBe(5);

    const contents: string[] = [];
    for (const file of files) {
      const content = await fs.readFile(path.join(pendingDir, file), 'utf-8');
      const decoded = decodeInbox(content);
      contents.push(decoded.content);
    }
    expect(contents.sort()).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
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
    expect(files[0]).toMatch(new RegExp(`^motion-\\d{15}_high_${UUID_V4_RE}\\.md$`, 'i'));
  });

  it('writeSync reuses a single UUID for envelope id and filename suffix', () => {
    writer.writeSync({
      type: 'ping',
      source: 'motion',
      priority: 'normal',
      body: 'test',
    });

    const files = fsSync.readdirSync(path.join(testDir, 'inbox', 'pending'));
    expect(files).toHaveLength(1);
    const suffix = extractUuid(files[0]);
    expect(suffix).toBeDefined();

    const content = fsSync.readFileSync(path.join(testDir, 'inbox', 'pending', files[0]), 'utf-8');
    const decoded = decodeInbox(content);
    expect(decoded.id).toBe(`ping-${suffix}`);
  });

  it('writeSync audits INBOX_WRITTEN on success', () => {
    writer.writeSync({ type: 'ping', source: 'motion', priority: 'normal', body: 'test' });
    const written = auditCalls.find(c => c.startsWith('inbox_written:'));
    expect(written).toBeDefined();
    // phase 1851 Step B: messaging events record message identity only
    expect(written).toMatch(/id=ping-[0-9a-f-]+/);
    expect(written).toContain('type=ping');
  });

  it('writeSync includes metadata in the written message', () => {
    writer.writeSync({
      type: 'ping',
      source: 'motion',
      priority: 'normal',
      body: 'test body',
      metadata: { contract_id: 'c1' },
    });

    const files = fsSync.readdirSync(path.join(testDir, 'inbox', 'pending'));
    expect(files).toHaveLength(1);
    const content = fsSync.readFileSync(path.join(testDir, 'inbox', 'pending', files[0]), 'utf-8');
    expect(content).toContain('contract_id: "c1"');
    // phase 1851 Step B: metadata stays opaque — audit events never echo it
    expect(auditCalls.some(c => c.includes('contract_id'))).toBe(false);
  });

  it('audits INBOX_WRITE_FAILED when ensureDir fails', () => {
    vi.spyOn(nfs, 'ensureDirSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    expect(() =>
      writer.writeSync({
        type: 'ping',
        source: 'motion',
        priority: 'normal',
        body: 'test',
        metadata: { contract_id: 'c1' },
      }),
    ).toThrow();
    const failed = auditCalls.find(c => c.startsWith('inbox_write_failed:'));
    expect(failed).toBeDefined();
    expect(failed).toContain('type=ping');
    // phase 1851 Step B: metadata stays opaque — audit events never echo it
    expect(failed).not.toContain('contract_id');
  });

  // ─── .readMeta() ─────────────────────────────────────────────────────────

  it('readMeta returns ok with meta for valid file', async () => {
    const msg: InboxMessage = {
      id: `meta-test-${randomUUID()}`, type: 'message', from: 's', to: 'c',
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


describe('InboxWriter boundary safety (phase 910)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `inbox-writer-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    const audit = { write() { /* noop */ } };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('write rejects path traversal in from field', async () => {
    const msg: InboxMessage = {
      id: `x-${randomUUID()}`, type: 'message', from: '../../etc', to: 'claw',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    };
    await expect(writer.write(msg)).rejects.toThrow(/Invalid message identifier/);
  });

  it('writeSync rejects path traversal in source field', () => {
    expect(() =>
      writer.writeSync({ type: 'ping', source: 'a/b', priority: 'normal', body: 'x' }),
    ).toThrow(/Invalid message identifier/);
  });
});


