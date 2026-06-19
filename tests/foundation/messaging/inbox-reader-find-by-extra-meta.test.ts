import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
    events,
  };
}

describe('InboxReader.findByExtraMeta', () => {
  let root: string;
  let pendingDir: string;
  let doneDir: string;
  let failedDir: string;
  let inflightDir: string;
  let fs: NodeFileSystem;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    root = path.join(tmpdir(), `find-extra-meta-${randomUUID()}`);
    pendingDir = path.join(root, 'inbox/pending');
    doneDir = path.join(root, 'inbox/done');
    failedDir = path.join(root, 'inbox/failed');
    inflightDir = path.join(root, 'inbox/inflight');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.mkdir(doneDir, { recursive: true });
    await fsAsync.mkdir(failedDir, { recursive: true });
    await fsAsync.mkdir(inflightDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit } = makeAudit();
    reader = new InboxReader(pendingDir, doneDir, failedDir, fs, audit, inflightDir);
    writer = InboxWriter.__internal_create(fs, makeInboxPath(pendingDir), audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('returns null when pending + done both empty', async () => {
    expect(await reader.findByExtraMeta('hash', 'abc', { includeDoneWithinMs: 86400000 })).toBeNull();
  });

  it('hits pending when extraMeta matches', async () => {
    await writer.write({
      id: 'm1', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'abc123' });
    const hit = await reader.findByExtraMeta('hash', 'abc123');
    expect(hit).not.toBeNull();
    expect(hit?.location).toBe('pending');
  });

  it('hits inflight when extraMeta matches and file drained but not acked', async () => {
    await writer.write({
      id: 'inf', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'inflight123' });
    // drainAndDeliver moves pending → inflight, ack/nack not called
    await reader.drainAndDeliver();
    const hit = await reader.findByExtraMeta('hash', 'inflight123');
    expect(hit).not.toBeNull();
    expect(hit?.location).toBe('inflight');
  });

  it('does NOT match failed/ (caller should re-emit on failures)', async () => {
    await writer.write({
      id: 'fail', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'failed-hash' });
    const drained = await reader.drainAndDeliver();
    await reader.markFailed(drained.handles[0].filePath);
    const hit = await reader.findByExtraMeta('hash', 'failed-hash', { includeDoneWithinMs: 86400000 });
    expect(hit).toBeNull();  // explicit decline: failed/ not scanned
  });

  it('hits done within window', async () => {
    await writer.write({
      id: 'm2', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'def456' });
    const drained = await reader.drainAndDeliver();
    await reader.ack(drained.handles[0]);
    const hit = await reader.findByExtraMeta('hash', 'def456', { includeDoneWithinMs: 86400000 });
    expect(hit).not.toBeNull();
    expect(hit?.location).toBe('done');
  });

  it('skips done outside window', async () => {
    await writer.write({
      id: 'm3', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'ghi789' });
    const drained = await reader.drainAndDeliver();
    await reader.ack(drained.handles[0]);
    const doneFiles = await fsAsync.readdir(doneDir);
    const old = (Date.now() - 86400000 - 60000) / 1000;
    await fsAsync.utimes(path.join(doneDir, doneFiles[0]), old, old);
    const hit = await reader.findByExtraMeta('hash', 'ghi789', { includeDoneWithinMs: 86400000 });
    expect(hit).toBeNull();
  });

  it('returns null when no matching extraMeta value', async () => {
    await writer.write({
      id: 'm4', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'aaa' });
    const hit = await reader.findByExtraMeta('hash', 'bbb', { includeDoneWithinMs: 86400000 });
    expect(hit).toBeNull();
  });

  it('returns first hit not all matches', async () => {
    await writer.write({
      id: 'm5', type: 'test', from: 'sys', to: 'motion',
      content: 'x1', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'same' });
    await writer.write({
      id: 'm6', type: 'test', from: 'sys', to: 'motion',
      content: 'x2', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'same' });
    const hit = await reader.findByExtraMeta('hash', 'same');
    expect(hit).not.toBeNull();
  });
});
