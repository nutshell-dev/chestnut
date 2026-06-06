/**
 * phase 1476: hash + scan unit tests (real NodeFileSystem + tmpdir).
 * phase 42: scanOutboxes 改 async + 注入 OutboxReader。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { computeHash } from '../../../src/core/outbox-summary/hash.js';
import { scanOutboxes } from '../../../src/core/outbox-summary/scan.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeChestnutRoot } from '../../../src/assembly/install-paths.js';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } },
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
  let outboxReader: OutboxReader;

  beforeEach(async () => {
    root = path.join(tmpdir(), `outbox-summary-scan-${randomUUID()}`);
    await fsAsync.mkdir(path.join(root, 'claws'), { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit } = makeAudit();
    outboxReader = new OutboxReader(fs, audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('empty claws dir → empty state', async () => {
    const state = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    expect(state.counts).toEqual({});
    expect(state.total_claws).toBe(0);
    expect(state.total_msgs).toBe(0);
    expect(state.file_set).toEqual([]);
    expect(state.previews).toEqual({});
  });

  it('skips motion claw', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/motion/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/motion/outbox/pending/foo.md'), 'x');
    const state = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    expect(state.counts).toEqual({});
    expect(state.previews).toEqual({});
  });

  it('counts pending files per claw', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), 'x');
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a2.md'), 'x');
    await fsAsync.writeFile(path.join(root, 'claws/clawB/outbox/pending/b1.md'), 'x');
    const state = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    expect(state.counts).toEqual({ clawA: 2, clawB: 1 });
    expect(state.total_claws).toBe(2);
    expect(state.total_msgs).toBe(3);
    expect(state.file_set).toEqual(['clawA:a1.md', 'clawA:a2.md', 'clawB:b1.md']);
    expect(state.previews).toEqual({ clawA: '(读取失败)', clawB: '(读取失败)' });
  });

  it('ignores non-.md files', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/a1.md'), 'x');
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/junk.txt'), 'x');
    const state = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    expect(state.counts).toEqual({ clawA: 1 });
    expect(state.previews).toEqual({ clawA: '(读取失败)' });
  });

  it('claws/<id>/outbox missing → silent skip', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA'), { recursive: true });
    const state = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    expect(state.counts).toEqual({});
    expect(state.previews).toEqual({});
  });

  it('hash deterministic for same fileSet', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m1.md'), 'x');
    await fsAsync.writeFile(path.join(root, 'claws/clawA/outbox/pending/m2.md'), 'x');
    const a = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    const b = await scanOutboxes({ clawsDir: `${root}/claws`, fs, outboxReader });
    expect(a.hash).toBe(b.hash);
  });
});
