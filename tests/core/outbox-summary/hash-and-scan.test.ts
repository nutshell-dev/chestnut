/**
 * phase 1476: hash + scan unit tests (real NodeFileSystem + tmpdir).
 * phase 42: scanOutboxes 改 async + 注入 OutboxReader。
 */

import { makeChestnutRoot } from '../../../src/foundation/claw-identity/index.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { computeHash } from '../../../src/core/claw-topology/jobs/outbox-summary/hash.js';
import { scanOutboxes } from '../../../src/core/claw-topology/jobs/outbox-summary/scan.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createOutboxReader, type OutboxReader } from '../../../src/foundation/messaging/index.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/foundation/claw-identity/claw-id.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
    events,
  };
}

describe('phase 1476: computeHash', () => {
  it('returns 12-char hex', () => {
    expect(computeHash(['clawA:msg1.md'])).toMatch(/^[a-f0-9]{12}$/);
  });

  it('empty set yields fixed hash', () => {
    expect(computeHash([])).toBe(computeHash([]));
  });

  it('same fileSet → same hash', () => {
    const set = ['clawA:m1.md', 'clawA:m2.md', 'clawB:n1.md'];
    expect(computeHash(set)).toBe(computeHash(set));
  });

  it('different msg with same count → different hash (anti-pattern #2)', () => {
    const a = computeHash(['clawA:m1.md', 'clawA:m2.md', 'clawA:m3.md']);
    const b = computeHash(['clawA:m4.md', 'clawA:m5.md', 'clawA:m6.md']);
    expect(a).not.toBe(b);
  });

  it('order matters (caller must sort first)', () => {
    expect(computeHash(['clawA:m1.md', 'clawB:m1.md']))
      .not.toBe(computeHash(['clawB:m1.md', 'clawA:m1.md']));
  });
});

describe('phase 1476: scanOutboxes (real fs)', () => {
  let root: string;
  let fs: NodeFileSystem;
  let outboxReaderFactory: (clawRoot: string) => OutboxReader;
  let topology: ClawTopology;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `outbox-summary-scan-${randomUUID()}`);
    await fsAsync.mkdir(path.join(root, 'claws'), { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit } = makeAudit();
    outboxReaderFactory = clawRoot => createOutboxReader({ clawRoot, fs, audit });
    topology = createClawTopology({
      fs,
      chestnutRoot: root,
      motionClawId: makeClawId('motion'),
      motionDir: 'motion',
    });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('empty claws dir → empty state', async () => {
    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    expect(state.counts).toEqual({});
    expect(state.total_claws).toBe(0);
    expect(state.total_msgs).toBe(0);
    expect(state.file_set).toEqual([]);
    expect(state.previews).toEqual({});
    expect(state.failed_claws).toEqual([]);
    expect(state.incomplete).toBe(false);
  });

  it('skips motion claw', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/motion/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/motion/outbox/pending/foo.md'), 'x');
    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    expect(state.counts).toEqual({});
    expect(state.previews).toEqual({});
    expect(state.failed_claws).toEqual([]);
    expect(state.incomplete).toBe(false);
  });

  it('counts pending files per claw', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    const makeMsg = (content: string, ts: string) => ({
      id: `m-${ts}`,
      type: 'report' as const,
      from: 'clawA',
      to: 'motion',
      content,
      timestamp: ts,
      priority: 'normal' as const,
    });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), encodeOutbox(makeMsg('a1', '2026-06-04T10:00:00Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a2.md'), encodeOutbox(makeMsg('a2', '2026-06-04T10:00:01Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), encodeOutbox(makeMsg('b1', '2026-06-04T10:00:02Z')));
    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    expect(state.counts).toEqual({ clawA: 2, clawB: 1 });
    expect(state.total_claws).toBe(2);
    expect(state.total_msgs).toBe(3);
    expect(state.file_set).toEqual(['clawA:a1.md', 'clawA:a2.md', 'clawB:b1.md']);
    expect(state.previews).toEqual({ clawA: 'a2', clawB: 'b1' });
    expect(state.failed_claws).toEqual([]);
    expect(state.incomplete).toBe(false);
  });

  it('ignores non-.md files', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    const msg = {
      id: 'm-1',
      type: 'report' as const,
      from: 'clawA',
      to: 'motion',
      content: 'a1',
      timestamp: '2026-06-04T10:00:00Z',
      priority: 'normal' as const,
    };
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), encodeOutbox(msg));
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/junk.txt'), 'x');
    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    expect(state.counts).toEqual({ clawA: 1 });
    expect(state.previews).toEqual({ clawA: 'a1' });
    expect(state.failed_claws).toEqual([]);
    expect(state.incomplete).toBe(false);
  });

  it('claws/<id>/outbox missing → silent skip', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA'), { recursive: true });
    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    expect(state.counts).toEqual({});
    expect(state.previews).toEqual({});
    expect(state.failed_claws).toEqual([]);
    expect(state.incomplete).toBe(false);
  });

  it('hash deterministic for same fileSet', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    const makeMsg = (content: string, ts: string) => ({
      id: `m-${ts}`,
      type: 'report' as const,
      from: 'clawA',
      to: 'motion',
      content,
      timestamp: ts,
      priority: 'normal' as const,
    });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), encodeOutbox(makeMsg('m1', '2026-06-04T10:00:00Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m2.md'), encodeOutbox(makeMsg('m2', '2026-06-04T10:00:01Z')));
    const a = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    const b = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory });
    expect(a.hash).toBe(b.hash);
  });

  it('records failed claws and marks summary incomplete', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    const makeMsg = (content: string, ts: string) => ({
      id: `m-${ts}`,
      type: 'report' as const,
      from: 'clawA',
      to: 'motion',
      content,
      timestamp: ts,
      priority: 'normal' as const,
    });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), encodeOutbox(makeMsg('a1', '2026-06-04T10:00:00Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), encodeOutbox(makeMsg('b1', '2026-06-04T10:00:00Z')));

    const failure = new Error('mock I/O failure');
    const failingReaderFactory = (clawRoot: string): OutboxReader => {
      const realReader = createOutboxReader({ clawRoot, fs, audit: { write: () => undefined } });
      if (path.basename(clawRoot) === 'clawB') {
        return {
          listPendingResult: async () => ({
            kind: 'failed', stage: 'list', path: path.join(clawRoot, 'outbox/pending'), error: failure,
          }),
        } as unknown as OutboxReader;
      }
      return realReader;
    };

    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory: failingReaderFactory });
    expect(state.counts).toEqual({ clawA: 1 });
    expect(state.total_claws).toBe(1);
    expect(state.total_msgs).toBe(1);
    expect(state.file_set).toEqual(['clawA:a1.md']);
    expect(state.failed_claws).toEqual(['clawB']);
    expect(state.incomplete).toBe(true);
  });

  it('aborts scan when signal is triggered', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), 'x');

    const controller = new AbortController();
    controller.abort();

    await expect(
      scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
  });

  it('aborts before the next claw when signal fires mid-scan', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), 'x');
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), 'x');

    const controller = new AbortController();
    const interceptReaderFactory = (clawRoot: string): OutboxReader => {
      const realReader = createOutboxReader({ clawRoot, fs, audit: { write: () => undefined } });
      return {
        listPendingResult: async () => {
          const listed = await realReader.listPendingResult();
          if (path.basename(clawRoot) === 'clawA') controller.abort();
          return listed;
        },
        peekLastOutboxPending: realReader.peekLastOutboxPending.bind(realReader),
      } as unknown as OutboxReader;
    };

    await expect(
      scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory: interceptReaderFactory, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
  });

  it('does not swallow an unexpected resolve failure', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    const makeMsg = (content: string, ts: string) => ({
      id: `m-${ts}`,
      type: 'report' as const,
      from: 'clawA',
      to: 'motion',
      content,
      timestamp: ts,
      priority: 'normal' as const,
    });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), encodeOutbox(makeMsg('a1', '2026-06-04T10:00:00Z')));
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), encodeOutbox(makeMsg('b1', '2026-06-04T10:00:00Z')));

    const resolveSpy = vi.spyOn(topology, 'resolve').mockImplementation((clawId: string) => {
      if (clawId === 'clawA') throw new Error('resolve boom');
      return { kind: 'local', clawDir: path.join(root, 'claws', clawId) };
    });

    await expect(scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory }))
      .rejects.toThrow('resolve boom');
    resolveSpy.mockRestore();
  });

  it('marks claw as failed when peek snapshot is empty after list succeeds (consumer race)', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), 'x');

    const peekFailingReaderFactory = (clawRoot: string): OutboxReader => {
      const realReader = createOutboxReader({ clawRoot, fs, audit: { write: () => undefined } });
      return {
        listPendingResult: realReader.listPendingResult.bind(realReader),
        peekLastOutboxPending: vi.fn().mockResolvedValue({ kind: 'empty' }),
      } as unknown as OutboxReader;
    };

    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory: peekFailingReaderFactory });
    expect(state.counts).toEqual({});
    expect(state.file_set).toEqual([]);
    expect(state.previews).toEqual({});
    expect(state.failed_claws).toEqual(['clawA']);
    expect(state.incomplete).toBe(true);
  });

  it('marks claw as failed when peek returns typed failed（phase 1784：failure 不得当空队列）', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), 'x');

    const boom = new Error('decode boom');
    const peekFailingReaderFactory = (clawRoot: string): OutboxReader => {
      const realReader = createOutboxReader({ clawRoot, fs, audit: { write: () => undefined } });
      return {
        listPendingResult: realReader.listPendingResult.bind(realReader),
        peekLastOutboxPending: vi.fn().mockResolvedValue({
          kind: 'failed',
          stage: 'decode',
          path: path.join(root, 'claws/clawA/outbox/pending/a1.md'),
          error: boom,
        }),
      } as unknown as OutboxReader;
    };

    const state = await scanOutboxes({ clawTopology: topology, fs, outboxReaderFactory: peekFailingReaderFactory });
    // failed 不压平为空队列：不计数、不入 file_set/previews，记 failed_claws + incomplete
    expect(state.counts).toEqual({});
    expect(state.file_set).toEqual([]);
    expect(state.previews).toEqual({});
    expect(state.failed_claws).toEqual(['clawA']);
    expect(state.incomplete).toBe(true);
  });
});
