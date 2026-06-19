/**
 * phase 44: scan preview collection + truncatePreview unit tests.
 */

import { makeChestnutRoot } from '../../../src/foundation/install-paths.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { scanOutboxes, truncatePreview } from '../../../src/core/cron/jobs/outbox-summary/scan.js';
import { PREVIEW_MAX_CHARS } from '../../../src/core/cron/jobs/outbox-summary/types.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { OutboxReader } from '../../../src/foundation/messaging/index.js';
import { encodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';
import { createClawTopology } from '../../../src/core/claw-topology/topology.js';
import { makeClawId } from '../../../src/core/claw-id.js';
import type { ClawTopology } from '../../../src/core/claw-topology/types.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s},
    events,
  };
}

function makeMsg(content: string, ts: string): OutboxMessage {
  return {
    id: `m-${ts}`,
    type: 'response',
    from: 'clawA',
    to: 'motion',
    content,
    timestamp: ts,
    priority: 'normal',
  };
}

describe('truncatePreview', () => {
  it('returns full content when within limit', () => {
    expect(truncatePreview('hello')).toBe('hello');
  });

  it('truncates with ellipsis when over limit', () => {
    const long = 'a'.repeat(50);
    const result = truncatePreview(long);
    expect(Array.from(result).length).toBe(PREVIEW_MAX_CHARS + 1);
    expect(result.endsWith('…')).toBe(true);
  });

  it('takes first line only', () => {
    expect(truncatePreview('line1\nline2\nline3')).toBe('line1');
  });

  it('handles empty / whitespace-only content', () => {
    expect(truncatePreview('')).toBe('(空消息)');
    expect(truncatePreview('   ')).toBe('(空消息)');
    expect(truncatePreview('\n\n\n')).toBe('(空消息)');
  });

  it('handles multi-byte chars (Chinese)', () => {
    const chinese = '契约X完成、3件子任务全pass、报告已生成在clawspace';
    expect(truncatePreview(chinese)).toBe(chinese);
  });

  it('truncates long Chinese without surrogate pair break', () => {
    const long = '契约'.repeat(30);
    const result = truncatePreview(long);
    expect(Array.from(result).length).toBe(PREVIEW_MAX_CHARS + 1);
  });

  it('handles emoji (surrogate pairs)', () => {
    const emojis = '🎉'.repeat(50);
    const result = truncatePreview(emojis);
    expect(Array.from(result).length).toBe(PREVIEW_MAX_CHARS + 1);
  });

  it('handles CRLF by taking first line', () => {
    expect(truncatePreview('first\r\nsecond')).toBe('first');
  });
});

describe('scanOutboxes preview collection', () => {
  let root: string;
  let fs: NodeFileSystem;
  let outboxReader: OutboxReader;
  let topology: ClawTopology;

  beforeEach(async () => {
    root = path.join(tmpdir(), `outbox-summary-preview-${randomUUID()}`);
    await fsAsync.mkdir(path.join(root, 'claws'), { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit } = makeAudit();
    outboxReader = new OutboxReader(fs, audit);
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

  it('collects preview from latest message per claw', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(
      path.join(root, 'claws/clawA/outbox/pending/1717480000000_normal_aaa.md'),
      encodeOutbox(makeMsg('hello world', '2026-06-04T10:00:00Z')),
    );
    await fsAsync.writeFile(
      path.join(root, 'claws/clawA/outbox/pending/1717480000001_normal_bbb.md'),
      encodeOutbox(makeMsg('latest message here', '2026-06-04T11:00:00Z')),
    );

    const state = await scanOutboxes({ clawsDir: `${root}/claws`, clawTopology: topology, fs, outboxReader });
    expect(state.previews).toEqual({ clawA: 'latest message here' });
  });

  it('truncates long previews', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    const longContent = 'a'.repeat(100);
    await fsAsync.writeFile(
      path.join(root, 'claws/clawA/outbox/pending/1717480000000_normal_aaa.md'),
      encodeOutbox(makeMsg(longContent, '2026-06-04T10:00:00Z')),
    );

    const state = await scanOutboxes({ clawsDir: `${root}/claws`, clawTopology: topology, fs, outboxReader });
    expect(state.previews.clawA).toBe('a'.repeat(PREVIEW_MAX_CHARS) + '…');
  });

  it('marks read failure when decode fails', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(
      path.join(root, 'claws/clawA/outbox/pending/1717480000000_normal_aaa.md'),
      'INVALID CONTENT',
    );

    const state = await scanOutboxes({ clawsDir: `${root}/claws`, clawTopology: topology, fs, outboxReader });
    expect(state.counts).toEqual({ clawA: 1 });
    expect(state.previews).toEqual({ clawA: '(读取失败)' });
  });

  it('handles multiple claws with previews', async () => {
    await fsAsync.mkdir(path.join(root, 'claws/clawA/outbox/pending'), { recursive: true });
    await fsAsync.mkdir(path.join(root, 'claws/clawB/outbox/pending'), { recursive: true });
    await fsAsync.writeFile(
      path.join(root, 'claws/clawA/outbox/pending/1717480000000_normal_aaa.md'),
      encodeOutbox(makeMsg('clawA says hi', '2026-06-04T10:00:00Z')),
    );
    await fsAsync.writeFile(
      path.join(root, 'claws/clawB/outbox/pending/1717480000000_normal_bbb.md'),
      encodeOutbox(makeMsg('clawB reports done', '2026-06-04T10:00:00Z')),
    );

    const state = await scanOutboxes({ clawsDir: `${root}/claws`, clawTopology: topology, fs, outboxReader });
    expect(state.previews).toEqual({
      clawA: 'clawA says hi',
      clawB: 'clawB reports done',
    });
  });
});
