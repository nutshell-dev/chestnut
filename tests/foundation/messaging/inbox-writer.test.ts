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

  it('audits INBOX_WRITE_FAILED and rethrows reserved extraFields encode errors', () => {
    expect(() => writer.writeSync({
      type: 'ping',
      source: 'motion',
      body: 'test',
      extraFields: { id: 'override' },
    })).toThrow(/conflicts with reserved frontmatter field/);

    const failed = auditCalls.find(c => c.startsWith('inbox_write_failed:'));
    expect(failed).toBeDefined();
    expect(failed).toContain('type=ping');
    expect(fsSync.existsSync(path.join(testDir, INBOX_PENDING_DIR))).toBe(false);
  });

  it('audits INBOX_WRITE_FAILED and rethrows unsafe metadata key errors', () => {
    expect(() => writer.writeSync({
      type: 'ping',
      source: 'motion',
      body: 'test',
      metadata: { 'bad\nkey': 'value' },
    })).toThrow();

    expect(auditCalls.some(c => c.startsWith('inbox_write_failed:'))).toBe(true);
    expect(fsSync.existsSync(path.join(testDir, INBOX_PENDING_DIR))).toBe(false);
  });

  it('audits INBOX_WRITE_FAILED and rethrows non-ENOENT dedup list errors', () => {
    vi.spyOn(nfs, 'listSync').mockImplementation(() => {
      throw Object.assign(new Error('dedup list failed'), { code: 'EIO' });
    });

    expect(() => writer.writeSync({
      type: 'ping',
      source: 'motion',
      body: 'test',
      messageId: 'stable-1',
    })).toThrow('dedup list failed');

    const failed = auditCalls.find(c => c.startsWith('inbox_write_failed:'));
    expect(failed).toBeDefined();
    expect(failed).toContain('id=stable-1');
    expect(failed).toContain('type=ping');
  });

  it('rejects unsafe stable ids with INBOX_WRITE_FAILED and no wire file', () => {
    expect(() => writer.writeSync({
      type: 'ping',
      source: 'motion',
      body: 'test',
      messageId: 'bad\n---',
    })).toThrow(/unsafe id/);

    expect(auditCalls.some(c => c.startsWith('inbox_write_failed:'))).toBe(true);
    expect(fsSync.existsSync(path.join(testDir, INBOX_PENDING_DIR))).toBe(false);
  });

  it.each(['pending', 'inflight'] as const)('writeSync dedupes a stable messageId in %s', (state) => {
    const opts = { type: 'ping', source: 'motion', body: 'test', messageId: 'stable-state' };
    const original = writer.writeSync(opts);
    let existing = original;
    if (state === 'inflight') {
      const inflightDir = path.join(testDir, 'inbox', 'inflight');
      existing = `mclaim_1_${randomUUID()}.md`;
      fsSync.mkdirSync(inflightDir, { recursive: true });
      fsSync.renameSync(path.join(testDir, INBOX_PENDING_DIR, original), path.join(inflightDir, existing));
    }

    expect(writer.writeSync(opts)).toBe(existing);
    const pendingFiles = fsSync.readdirSync(path.join(testDir, INBOX_PENDING_DIR));
    expect(pendingFiles).toHaveLength(state === 'pending' ? 1 : 0);
    if (state === 'inflight') {
      expect(fsSync.readdirSync(path.join(testDir, 'inbox', 'inflight'))).toEqual([existing]);
    }
    expect(auditCalls.filter(c => c.startsWith('inbox_deduped:'))).toHaveLength(1);
  });

  it('writeSync dedupes a stable messageId inside the explicit done window', () => {
    const opts = { type: 'ping', source: 'motion', body: 'test', messageId: 'stable-done' };
    const original = writer.writeSync(opts);
    const doneDir = path.join(testDir, 'inbox', 'done');
    fsSync.mkdirSync(doneDir, { recursive: true });
    fsSync.renameSync(path.join(testDir, INBOX_PENDING_DIR, original), path.join(doneDir, original));

    expect(writer.writeSync({ ...opts, includeDoneWithinMs: 60_000 })).toBe(original);
    expect(fsSync.readdirSync(path.join(testDir, INBOX_PENDING_DIR))).toHaveLength(0);
    expect(auditCalls.filter(c => c.startsWith('inbox_deduped:'))).toHaveLength(1);
  });

  it('writeSync allows a new write when the done message is outside the window', () => {
    const opts = { type: 'ping', source: 'motion', body: 'test', messageId: 'old-done' };
    const original = writer.writeSync(opts);
    const doneDir = path.join(testDir, 'inbox', 'done');
    fsSync.mkdirSync(doneDir, { recursive: true });
    const doneFile = path.join(doneDir, original);
    fsSync.renameSync(path.join(testDir, INBOX_PENDING_DIR, original), doneFile);
    const old = new Date(Date.now() - 120_000);
    fsSync.utimesSync(doneFile, old, old);

    expect(writer.writeSync({ ...opts, includeDoneWithinMs: 1_000 })).not.toBe(original);
    expect(fsSync.readdirSync(path.join(testDir, INBOX_PENDING_DIR))).toHaveLength(1);
    expect(auditCalls.some(c => c.startsWith('inbox_deduped:'))).toBe(false);
  });

  it('async write dedupes by messageId only when explicitly enabled', async () => {
    const msg: InboxMessage = {
      id: 'async-stable', type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);
    await writer.write(msg, undefined, { dedupeByMessageId: false });
    expect(await fs.readdir(path.join(testDir, INBOX_PENDING_DIR))).toHaveLength(2);

    await writer.write(msg, undefined, { dedupeByMessageId: true });
    expect(await fs.readdir(path.join(testDir, INBOX_PENDING_DIR))).toHaveLength(2);
    expect(auditCalls.filter(c => c.startsWith('inbox_deduped:'))).toHaveLength(1);
  });

  it.each(['inflight', 'done'] as const)('async opt-in dedupes a messageId in %s', async (state) => {
    const msg: InboxMessage = {
      id: `async-${state}`, type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);
    const [original] = await fs.readdir(path.join(testDir, INBOX_PENDING_DIR));
    const stateDir = path.join(testDir, 'inbox', state);
    const existing = state === 'inflight' ? `mclaim_1_${randomUUID()}.md` : original;
    await fs.mkdir(stateDir, { recursive: true });
    await fs.rename(path.join(testDir, INBOX_PENDING_DIR, original), path.join(stateDir, existing));

    await writer.write(msg, undefined, {
      dedupeByMessageId: true,
      ...(state === 'done' ? { includeDoneWithinMs: 60_000 } : {}),
    });

    expect(await fs.readdir(path.join(testDir, INBOX_PENDING_DIR))).toHaveLength(0);
    expect(await fs.readdir(stateDir)).toEqual([existing]);
    expect(auditCalls.filter(c => c.startsWith('inbox_deduped:'))).toHaveLength(1);
  });

  it('dedup scan rethrows non-ENOENT read failures instead of writing a duplicate', () => {
    const opts = { type: 'ping', source: 'motion', body: 'test', messageId: 'stable-read' };
    writer.writeSync(opts);
    vi.spyOn(nfs, 'readSync').mockImplementation(() => {
      throw Object.assign(new Error('identity read failed'), { code: 'EIO' });
    });

    expect(() => writer.writeSync(opts)).toThrow('identity read failed');
    expect(fsSync.readdirSync(path.join(testDir, INBOX_PENDING_DIR))).toHaveLength(1);
    expect(auditCalls.some(c => c.startsWith('inbox_write_failed:'))).toBe(true);
  });

  it('writeSync validates type before returning a stable-id dedup hit', () => {
    const opts = { type: 'ping', source: 'motion', body: 'test', messageId: 'stable-replay' };
    writer.writeSync(opts);

    expect(() => writer.writeSync({ ...opts, type: 'bad\n---' })).toThrow(/unsafe type/);
    expect(auditCalls.some(c => c.startsWith('inbox_deduped:'))).toBe(false);
    expect(auditCalls.some(c => c.startsWith('inbox_write_failed:'))).toBe(true);
  });

  it('async opt-in validates type before returning a dedup hit', async () => {
    const msg: InboxMessage = {
      id: 'async-replay', type: 'message', from: 'sender', to: 'claw',
      content: 'Hello', priority: 'normal', timestamp: new Date().toISOString(),
    };
    await writer.write(msg);

    await expect(writer.write(
      { ...msg, type: 'bad\n---' },
      undefined,
      { dedupeByMessageId: true },
    )).rejects.toThrow(/unsafe type/);
    expect(auditCalls.some(c => c.startsWith('inbox_deduped:'))).toBe(false);
    expect(auditCalls.some(c => c.startsWith('inbox_write_failed:'))).toBe(true);
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


