/**
 * Phase 1869 Step C: InboxReader.peekUnsettled —— 未结算事实枚举（pending + inflight）。
 *
 * 语义契约：
 * - 扫 pending/ + inflight/（by-design 排除 done/failed，与 findByExtraMeta 同口径）；
 * - 解码后按三要素（type / from / metadata.contract_id）精确匹配，返回全部命中 + 位置；
 * - 只读（无 init/drain/ack/move）；读取或解码失败原样抛出（不折空）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: {
      write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    },
    events,
  };
}

const FILTER = { type: 'execution_recovery', from: 'claw-a', contractId: 'c-1' };

describe('InboxReader.peekUnsettled (phase 1869 Step C)', () => {
  let root: string;
  let pendingDir: string;
  let doneDir: string;
  let failedDir: string;
  let inflightDir: string;
  let fs: NodeFileSystem;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `peek-unsettled-${randomUUID()}`);
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
    writer = InboxWriter.__internal_create(fs, makeInboxPath(pendingDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
  });

  const CLEANUP_TIMEOUT_MS = 2000;
  afterEach(async () => {
    await Promise.race([
      fsAsync.rm(root, { recursive: true, force: true }),
      new Promise(r => setTimeout(r, CLEANUP_TIMEOUT_MS)),
    ]).catch(() => { /* silent: cleanup timeout or fs error */ });
  });

  function writeRecovery(id: string, opts: { from?: string; contractId?: string; type?: string } = {}) {
    return writer.write({
      id,
      type: opts.type ?? FILTER.type,
      from: opts.from ?? FILTER.from,
      to: '',
      content: 'reminder',
      priority: 'high',
      timestamp: new Date().toISOString(),
      metadata: { contract_id: opts.contractId ?? FILTER.contractId },
    });
  }

  it('enumerates all hits in pending with locations', async () => {
    await writeRecovery('m1');
    await writeRecovery('m2');
    const hits = await reader.peekUnsettled(FILTER);
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.id).sort()).toEqual(['m1', 'm2']);
    expect(hits.every(h => h.location === 'pending')).toBe(true);
  });

  it('includes inflight hits (degraded reconcile 残留形态: pending 1 + inflight 1)', async () => {
    await writeRecovery('kept-pending');
    await writeRecovery('drained');
    // drain 全部 claim 到 inflight 后 nack 回队一条（模拟部分未结算残留）
    const drained = await reader.drainAndDeliver();
    if (drained.kind !== 'complete') throw new Error('expected complete drain');
    const pendIdx = drained.entries.findIndex(e => e.message.id === 'kept-pending');
    expect(drained.entries.findIndex(e => e.message.id === 'drained')).toBeGreaterThanOrEqual(0);
    await reader.nack(drained.handles[pendIdx], 'test_requeue');

    const hits = await reader.peekUnsettled(FILTER);
    expect(hits.map(h => h.id).sort()).toEqual(['drained', 'kept-pending']);
    expect(hits.find(h => h.id === 'drained')?.location).toBe('inflight');
    expect(hits.find(h => h.id === 'kept-pending')?.location).toBe('pending');
  });

  it('excludes done/ (acked reminders are settled, not unsettled facts)', async () => {
    await writeRecovery('done-one');
    const drained = await reader.drainAndDeliver();
    await reader.ack(drained.handles[0]);
    expect(await reader.peekUnsettled(FILTER)).toEqual([]);
  });

  it('excludes failed/', async () => {
    await writeRecovery('failed-one');
    const drained = await reader.drainAndDeliver();
    await reader.markFailed(drained.handles[0].filePath);
    expect(await reader.peekUnsettled(FILTER)).toEqual([]);
  });

  it('three-factor exact match: type / from / contractId each matter', async () => {
    await writeRecovery('other-type', { type: 'user_chat' });
    await writeRecovery('other-from', { from: 'claw-b' });
    await writeRecovery('other-contract', { contractId: 'c-2' });
    await writeRecovery('match');
    const hits = await reader.peekUnsettled(FILTER);
    expect(hits.map(h => h.id)).toEqual(['match']);
  });

  it('returns empty array when dirs are missing (ENOENT → no hits, no throw)', async () => {
    await fsAsync.rm(pendingDir, { recursive: true, force: true });
    await fsAsync.rm(inflightDir, { recursive: true, force: true });
    expect(await reader.peekUnsettled(FILTER)).toEqual([]);
  });

  it('propagates non-ENOENT list errors instead of returning empty', async () => {
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
    await expect(fragileReader.peekUnsettled(FILTER)).rejects.toThrow();
  });

  it('propagates read errors instead of folding to empty', async () => {
    await writeRecovery('boom');
    const errFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'read') {
          return async (p: string) => {
            if (p.includes('pending') && p.endsWith('.md')) {
              const e = new Error('io error') as NodeJS.ErrnoException;
              e.code = 'EIO';
              throw e;
            }
            return (target as unknown as Record<string, (p: string) => Promise<unknown>>).read(p);
          };
        }
        return (target as unknown as Record<string, unknown>)[prop];
      },
    }) as unknown as NodeFileSystem;
    const { audit } = makeAudit();
    const fragileReader = new InboxReader(pendingDir, doneDir, failedDir, errFs, audit, inflightDir);
    await expect(fragileReader.peekUnsettled(FILTER)).rejects.toThrow();
  });

  it('is non-consuming: repeated calls return the same facts', async () => {
    await writeRecovery('stable');
    const first = await reader.peekUnsettled(FILTER);
    const second = await reader.peekUnsettled(FILTER);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });
});
