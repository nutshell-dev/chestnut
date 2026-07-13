import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

  /**
   * afterEach cleanup timeout: macOS rm 在 watcher/fd 未释放时可能阻塞（phase 233）。
   * 2s 是经验上限——正常 rm 在 ms 级完成、超时仅在极端并发场景触发。
   * Derivation: > AfterEach default timeout 10s / 5 safety margin.
   */
  const CLEANUP_TIMEOUT_MS = 2000;

  afterEach(async () => {
    // phase 779 Step E: wrap rm in race with timeout — 高并发下 InboxReader/Writer
    // 可能持 watcher/fd 导致 macOS rm 阻塞（phase 233 观察）。超时兜底、不等。
    await Promise.race([
      fsAsync.rm(root, { recursive: true, force: true }),
      new Promise(r => setTimeout(r, CLEANUP_TIMEOUT_MS)),
    ]).catch(() => { /* silent: cleanup timeout or fs error */ });
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

  it('propagates non-ENOENT list errors instead of returning null (phase 931)', async () => {
    const errFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'list') {
          return async (dir: string) => {
            if (dir === pendingDir) {
              const e = new Error('permission denied') as NodeJS.ErrnoException;
              e.code = 'EACCES';
              throw e;
            }
            return (target as unknown as Record<string, (d: string) => Promise<unknown>>).list(dir);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop];
      },
    }) as unknown as NodeFileSystem;
    const { audit } = makeAudit();
    const fragileReader = new InboxReader(pendingDir, doneDir, failedDir, errFs, audit, inflightDir);
    await expect(fragileReader.findByExtraMeta('hash', 'abc')).rejects.toThrow();
  });

  it('propagates readMeta permission_denied instead of returning null (phase 932)', async () => {
    await writer.write({
      id: 'm-perm', type: 'test', from: 'sys', to: 'motion',
      content: 'x', priority: 'normal', timestamp: new Date().toISOString(),
    }, { hash: 'perm-hash' });

    const { InboxWriter } = await import('../../../src/foundation/messaging/inbox-writer.js');
    const originalReadMeta = InboxWriter.readMeta;
    InboxWriter.readMeta = () => ({ ok: false, error: { kind: 'permission_denied', cause: new Error('EACCES') } } as any);
    try {
      await expect(reader.findByExtraMeta('hash', 'perm-hash')).rejects.toThrow(/Dedup scan failed/);
    } finally {
      InboxWriter.readMeta = originalReadMeta;
    }
  });
});
