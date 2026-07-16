import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import {
  decodeInbox,
  encodeInbox,
  parseFrontmatter,
} from '../../../src/foundation/messaging/codec-inbox.js';
import {
  decodeOutbox,
  encodeOutbox,
} from '../../../src/foundation/messaging/codec-outbox.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';
import {
  InboxReader,
  InboxWriter,
  makeInboxPath,
} from '../../../src/foundation/messaging/index.js';
import type {
  InboxMessage,
  OutboxMessage,
} from '../../../src/foundation/messaging/types.js';

/**
 * Phase 1132 D.2: codec-inbox cross-key fallback 删除 + legacy claw_id extraMeta marker
 *
 * 反向测试：
 * 1. 仅 claw_id present → contract_id undefined + extraMeta.__legacy_claw_id = claw_id
 * 2. 仅 contract_id present → contract_id = value + 无 __legacy_claw_id
 * 3. 双 present → contract_id = meta.contract_id + __legacy_claw_id = meta.claw_id
 * 4. inbox-reader 扫描 legacy fixture → INBOX_LEGACY_CLAW_ID_FIELD audit emit
 */


describe('phase 1132 D.2: codec-inbox legacy claw_id', () => {
  it('case 1: 仅 claw_id present → contract_id undefined + extraMeta.__legacy_claw_id', () => {
    const raw = `---\nid: msg-1\ntype: heartbeat\nfrom: system\nto: claw1\npriority: normal\ntimestamp: 2026-05-20T00:00:00Z\nclaw_id: claw1\n---\n\nbody\n`;
    const msg = decodeInbox(raw);
    expect(msg.metadata?.contract_id).toBeUndefined();
    expect(msg.extraMeta?.__legacy_claw_id).toBe('claw1');
  });

  it('case 2: 仅 contract_id present → contract_id = value + 无 __legacy_claw_id', () => {
    const raw = `---\nid: msg-2\ntype: message\nfrom: sender\nto: claw1\npriority: high\ntimestamp: 2026-05-20T00:00:00Z\ncontract_id: contract-42\n---\n\nbody\n`;
    const msg = decodeInbox(raw);
    expect(msg.metadata?.contract_id).toBe('contract-42');
    expect(msg.extraMeta?.__legacy_claw_id).toBeUndefined();
  });

  it('case 3: 双 present → contract_id = meta.contract_id + __legacy_claw_id = meta.claw_id', () => {
    const raw = `---\nid: msg-3\ntype: message\nfrom: sender\nto: claw1\npriority: normal\ntimestamp: 2026-05-20T00:00:00Z\ncontract_id: contract-42\nclaw_id: claw1\n---\n\nbody\n`;
    const msg = decodeInbox(raw);
    expect(msg.metadata?.contract_id).toBe('contract-42');
    expect(msg.extraMeta?.__legacy_claw_id).toBe('claw1');
  });
});

describe('phase 1132 D.2: inbox-reader legacy claw_id audit', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `inbox-legacy-claw-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push({ type, cols: cols.map(String) });
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit);
    reader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await reader.init();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('case 4: legacy claw_id 文件触发 INBOX_LEGACY_CLAW_ID_FIELD audit', async () => {
    // 写一条带 claw_id 的 legacy format 消息
    const raw = `---\nid: msg-legacy\ntype: heartbeat\nfrom: system\nto: claw1\npriority: normal\ntimestamp: 2026-05-20T00:00:00Z\nclaw_id: claw1\n---\n\nheartbeat body\n`;
    const pendingFile = path.join(testDir, 'inbox', 'pending', 'legacy_msg.md');
    await fs.mkdir(path.dirname(pendingFile), { recursive: true });
    await fs.writeFile(pendingFile, raw, 'utf-8');

    const { entries: results } = await reader.drainInbox();

    expect(results).toHaveLength(1);
    expect(results[0].message.metadata?.contract_id).toBeUndefined();
    expect(results[0].message.extraMeta?.__legacy_claw_id).toBe('claw1');

    const legacyAudit = auditCalls.filter(
      (c) => c.type === MESSAGING_AUDIT_EVENTS.INBOX_LEGACY_CLAW_ID_FIELD,
    );
    expect(legacyAudit).toHaveLength(1);
    expect(legacyAudit[0].cols.some((c) => c.includes('claw_id=claw1'))).toBe(true);
  });
});

const baseMsg = (overrides: Partial<InboxMessage> = {}): InboxMessage => ({
  id: 'test-id',
  type: 'message',
  from: 'claw-a',
  to: 'claw-b',
  content: 'hello',
  priority: 'normal',
  timestamp: '2026-05-17T00:00:00Z',
  ...overrides,
});

describe('codec-inbox roundtrip (phase 907 / audit-2026-05-16 #7)', () => {
  it('roundtrip 含 double-quote in from', () => {
    const msg = baseMsg({ from: 'a"b' });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.from).toBe('a"b');
  });

  it('roundtrip 含 newline in metadata', () => {
    const msg = baseMsg({ metadata: { note: 'line1\nline2' } });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.metadata?.note).toBe('line1\nline2');
  });

  it('roundtrip 含 carriage-return in metadata', () => {
    const msg = baseMsg({ metadata: { note: 'a\rb' } });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.metadata?.note).toBe('a\rb');
  });

  it('roundtrip 含 literal backslash in from', () => {
    const msg = baseMsg({ from: 'a\\b' });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.from).toBe('a\\b');
  });

  it('roundtrip 含 combination (quote + newline)', () => {
    const msg = baseMsg({ from: 'a"b\nc' });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.from).toBe('a"b\nc');
  });

  it('roundtrip 含 literal backslash-n sequence (反向 marker collision 验)', () => {
    // 用户内容字面 `\n` 两字符（非 newline）应保留为字面
    const msg = baseMsg({ from: 'a\\nb' });   // 字面 2 char: backslash + n
    const round = decodeInbox(encodeInbox(msg));
    expect(round.from).toBe('a\\nb');
    expect(round.from).not.toBe('a\nb');   // 不应 unescape 为 newline
  });
});

describe('codec-inbox roundtrip extraMeta/metadata preservation (phase 1372 sub-3)', () => {
  it('roundtrip preserves extraMeta non-__ prefix fields into metadata', () => {
    const msg = baseMsg({ extraMeta: { customField: 'customValue' } });
    const round = decodeInbox(encodeInbox(msg));
    // extraMeta non-__ prefix is written to frontmatter by encode;
    // decode reads it back into metadata (round-trip data preserved)
    expect(round.metadata?.customField).toBe('customValue');
  });

  it('roundtrip preserves metadata fields', () => {
    const msg = baseMsg({ metadata: { project: 'alpha', tag: ' urgent' } });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.metadata?.project).toBe('alpha');
    expect(round.metadata?.tag).toBe(' urgent');
  });

  it('roundtrip preserves reply_to field', () => {
    const msg = baseMsg({ reply_to: 'reply-claw-1' });
    const round = decodeInbox(encodeInbox(msg));
    expect(round.reply_to).toBe('reply-claw-1');
  });

  it('roundtrip preserves extraFields via metadata', () => {
    const msg = baseMsg();
    const encoded = encodeInbox(msg, { extraField: 'extraValue' });
    const round = decodeInbox(encoded);
    expect(round.metadata?.extraField).toBe('extraValue');
  });

  it('multi-roundtrip does not lose business metadata', () => {
    let msg = baseMsg({ metadata: { biz: 'data' } });
    for (let i = 0; i < 3; i++) {
      msg = decodeInbox(encodeInbox(msg));
    }
    expect(msg.metadata?.biz).toBe('data');
  });
});

describe('codec-inbox round-trip symmetric invariant (audit-2026-05-16 §7 / phase 905)', () => {
  const base: InboxMessage = {
    id: 'm-1',
    type: 'message',
    from: 'motion',
    to: 'worker-1',
    content: 'body content',
    priority: 'normal',
    timestamp: '2026-05-17T00:00:00Z',
  };

  it('round-trip ASCII value 0 changed (反向 1: regression base case)', () => {
    const encoded = encodeInbox(base);
    const decoded = decodeInbox(encoded);
    expect(decoded.from).toBe('motion');
    expect(decoded.to).toBe('worker-1');
    expect(decoded.content).toBe('body content');
  });

  it('round-trip value with `\\n` `\\r` preserves real unicode chars (反向 2: asymmetric fix invariant)', () => {
    const msg: InboxMessage = { ...base, from: 'foo\nbar', metadata: { contract_id: 'line1\r\nline2' } };
    const encoded = encodeInbox(msg);
    const decoded = decodeInbox(encoded);
    expect(decoded.from).toBe('foo\nbar');
    expect(decoded.metadata?.contract_id).toBe('line1\r\nline2');
  });

  it('round-trip value with `\\\\` + `"` + literal `\\n` text preserves verbatim (反向 3: NUL placeholder collision-safe)', () => {
    const msg: InboxMessage = {
      ...base,
      from: 'path\\to\\file',
      metadata: { note: 'said "hi"', escaped: 'literal \\n stays' },
    };
    const encoded = encodeInbox(msg);
    const decoded = decodeInbox(encoded);
    expect(decoded.from).toBe('path\\to\\file');
    expect(decoded.metadata?.note).toBe('said "hi"');
    expect(decoded.metadata?.escaped).toBe('literal \\n stays');
  });
});


describe('codec-inbox boundary safety (phase 910)', () => {
  const base: InboxMessage = {
    id: 'm-1',
    type: 'message',
    from: 'motion',
    to: 'worker-1',
    content: 'body content',
    priority: 'normal',
    timestamp: '2026-05-17T00:00:00Z',
  };

  it('throws on unsafe metadata key', () => {
    const msg: InboxMessage = {
      ...base,
      metadata: { 'bad\nkey': 'value' },
    };
    expect(() => encodeInbox(msg)).toThrow(/unsafe/i);
  });

  it('throws on unsafe extraFields key', () => {
    const msg: InboxMessage = { ...base };
    expect(() => encodeInbox(msg, { 'key:value': 'x' })).toThrow(/unsafe/i);
  });

  it('throws on unsafe extraMeta key', () => {
    const msg: InboxMessage = {
      ...base,
      extraMeta: { '---': 'x' },
    };
    expect(() => encodeInbox(msg)).toThrow(/unsafe/i);
  });

  it('round-trips body with leading spaces and trailing newlines', () => {
    const body = '  hello\n\n';
    const encoded = `---\nid: x\ntype: msg\nfrom: a\nto: b\npriority: normal\ntimestamp: 2024\n---\n${body}`;
    const { body: decoded } = parseFrontmatter(encoded);
    expect(decoded).toBe(body);
  });
});

describe('codec-inbox strict decode invariant (phase 931)', () => {
  const base: InboxMessage = {
    id: 'm-1',
    type: 'message',
    from: 'motion',
    to: 'worker-1',
    content: 'body content',
    priority: 'normal',
    timestamp: '2026-05-17T00:00:00Z',
  };

  it('throws when from and source are both missing', () => {
    const encoded = encodeInbox({ ...base, from: '' });
    const rawWithoutFrom = encoded.replace(/^from:.*$/m, '');
    expect(() => decodeInbox(rawWithoutFrom)).toThrow(/missing required field: from/i);
  });

  it('throws when timestamp is missing', () => {
    const encoded = encodeInbox(base);
    const rawWithoutTimestamp = encoded.replace(/^timestamp:.*$/m, '');
    expect(() => decodeInbox(rawWithoutTimestamp)).toThrow(/missing required field: timestamp/i);
  });

  it('falls back to legacy source field when from is missing', () => {
    const raw = `---\nid: m-1\ntype: message\nsource: legacy\nto: worker-1\npriority: normal\ntimestamp: 2026-05-17T00:00:00Z\n---\nbody`;
    const decoded = decodeInbox(raw);
    expect(decoded.from).toBe('legacy');
  });

  it('throws when extraFields override reserved from key', () => {
    expect(() => encodeInbox(base, { from: 'attacker' })).toThrow(/conflicts with reserved frontmatter field/i);
  });

  it('throws when id is missing (phase 932)', () => {
    const encoded = encodeInbox(base);
    const rawWithoutId = encoded.replace(/^id:.*$/m, '');
    expect(() => decodeInbox(rawWithoutId)).toThrow(/missing required field: id/i);
  });

  it('throws when type is missing (phase 932)', () => {
    const encoded = encodeInbox(base);
    const rawWithoutType = encoded.replace(/^type:.*$/m, '');
    expect(() => decodeInbox(rawWithoutType)).toThrow(/missing required field: type/i);
  });

  it('throws when timestamp is malformed (phase 932)', () => {
    const encoded = encodeInbox(base);
    const rawWithBadTs = encoded.replace(/^timestamp:.*$/m, 'timestamp: broken');
    expect(() => decodeInbox(rawWithBadTs)).toThrow(/invalid timestamp/i);
  });
});

describe('codec-outbox', () => {
  it('should encode outbox message to YAML frontmatter format', () => {
    const msg: OutboxMessage = {
      id: 'test-id',
      type: 'question',
      from: 'claw-a',
      to: 'motion',
      content: 'hello world',
      timestamp: '2026-01-01T00:00:00.000Z',
      priority: 'normal',
    };
    const result = encodeOutbox(msg);

    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain('id: test-id');
    expect(result).toContain('type: question');
    expect(result).toContain('from: "claw-a"');
    expect(result).toContain('to: "motion"');
    expect(result).toContain('priority: normal');
    expect(result).toContain('timestamp: 2026-01-01T00:00:00.000Z');

    const bodyPart = result.split('\n---\n')[1];
    expect(bodyPart.trim()).toBe('hello world');
  });

  it('should roundtrip through decodeInbox', () => {
    const msg: OutboxMessage = {
      id: 'rt-id',
      type: 'response',
      from: 'claw-b',
      to: 'motion',
      content: 'roundtrip body',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'high',
    };
    const encoded = encodeOutbox(msg);
    const decoded = decodeInbox(encoded);

    expect(decoded.id).toBe(msg.id);
    expect(decoded.type).toBe(msg.type);
    expect(decoded.from).toBe(msg.from);
    expect(decoded.to).toBe(msg.to);
    expect(decoded.content).toBe(msg.content);
    expect(decoded.priority).toBe(msg.priority);
  });

  it('should handle metadata fields', () => {
    const msg: OutboxMessage = {
      id: 'meta-id',
      type: 'contract_update',
      from: 'claw-a',
      to: 'claw-b',
      content: 'update content',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
      metadata: { contract_id: 'abc-123', subtask_id: 'sub-1' },
    };
    const result = encodeOutbox(msg);

    expect(result).toContain('contract_id: "abc-123"');
    expect(result).toContain('subtask_id: "sub-1"');
  });

  it('should not include reserved fields from metadata', () => {
    const msg: OutboxMessage = {
      id: 'orig-id',
      type: 'question',
      from: 'orig-from',
      to: 'motion',
      content: 'test',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'low',
      metadata: { id: 'should-not-override', type: 'report', from: 'hijack' },
    };
    const result = encodeOutbox(msg);

    expect(result).toContain('id: orig-id');
    expect(result).toContain('from: "orig-from"');
    expect(result).toContain('type: question');
    expect(result).not.toContain('from: "hijack"');
    expect(result).not.toContain('id: should-not-override');
  });

  it('should yaml-quote values containing special chars', () => {
    const msg: OutboxMessage = {
      id: 'quote-id',
      type: 'question',
      from: 'claw "alpha"',
      to: 'motion',
      content: 'test',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
    };
    const result = encodeOutbox(msg);

    expect(result).toContain('from: "claw \\"alpha\\""');
  });

  // phase 1428 P5: decodeOutbox 镜像 decodeInbox 语义对称
  describe('decodeOutbox', () => {
    it('round-trips through encodeOutbox preserving base fields', () => {
      const msg: OutboxMessage = {
        id: 'rt-out',
        type: 'result',
        from: 'claw-b',
        to: 'motion',
        content: 'roundtrip outbox',
        timestamp: '2026-05-29T10:00:00.000Z',
        priority: 'high',
      };
      const decoded = decodeOutbox(encodeOutbox(msg));
      expect(decoded.id).toBe(msg.id);
      expect(decoded.type).toBe(msg.type);
      expect(decoded.from).toBe(msg.from);
      expect(decoded.to).toBe(msg.to);
      expect(decoded.content).toBe(msg.content);
      expect(decoded.priority).toBe(msg.priority);
      expect(decoded.timestamp).toBe(msg.timestamp);
    });

    it('passes through metadata fields (excluding reserved + __-prefixed)', () => {
      const msg: OutboxMessage = {
        id: 'meta-out',
        type: 'report',
        from: 'claw-a',
        to: 'claw-b',
        content: 'body',
        timestamp: '2026-05-29T10:00:00.000Z',
        priority: 'normal',
        metadata: { contract_id: 'abc', subtask_id: 'sub-1' },
      };
      const decoded = decodeOutbox(encodeOutbox(msg));
      expect(decoded.metadata).toEqual({ contract_id: 'abc', subtask_id: 'sub-1' });
    });

    it('decodes in_reply_to when present in raw frontmatter', () => {
      const raw = [
        '---',
        'id: r1',
        'type: question',
        'from: a',
        'to: b',
        'priority: normal',
        'timestamp: 2026-05-29T10:00:00.000Z',
        'in_reply_to: orig-msg-id',
        '---',
        '',
        'body',
        '',
      ].join('\n');
      const decoded = decodeOutbox(raw);
      expect(decoded.in_reply_to).toBe('orig-msg-id');
    });

    it('throws on missing YAML frontmatter', () => {
      expect(() => decodeOutbox('no frontmatter body')).toThrow(/missing YAML frontmatter/);
    });

    it('throws on missing required base fields', () => {
      expect(() => decodeOutbox('---\npriority: normal\n---\nbare')).toThrow(/missing required field: id/i);
      expect(() => decodeOutbox('---\nid: x\npriority: normal\n---\nbare')).toThrow(/missing required field: type/i);
      expect(() => decodeOutbox('---\nid: x\ntype: report\npriority: normal\n---\nbare')).toThrow(/missing required field: from/i);
      expect(() => decodeOutbox('---\nid: x\ntype: report\nfrom: a\npriority: normal\n---\nbare')).toThrow(/missing required field: timestamp/i);
    });

    it('allows empty to as broadcast', () => {
      const raw = '---\nid: x\ntype: error\nfrom: a\npriority: normal\ntimestamp: 2026-01-01\n---\nbare';
      const decoded = decodeOutbox(raw);
      expect(decoded.to).toBe('');
      expect(decoded.content).toBe('bare');
    });

    it('throws OutboxDecodeError for invalid type value', () => {
      expect(() => decodeOutbox('---\nid: x\ntype: response\nfrom: a\npriority: normal\ntimestamp: 2026-01-01T00:00:00Z\n---\nbody'))
        .toThrow(/invalid outbox type: "response"/);
    });

    it('throws OutboxDecodeError for invalid timestamp', () => {
      expect(() => decodeOutbox('---\nid: x\ntype: report\nfrom: a\npriority: normal\ntimestamp: not-a-date\n---\nbody'))
        .toThrow(/invalid outbox timestamp: "not-a-date"/);
    });
  });
});


describe('codec-outbox boundary safety (phase 910)', () => {
  it('throws on unsafe metadata key', () => {
    const msg = {
      id: 'test-id',
      type: 'question',
      from: 'claw-a',
      to: 'motion',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      priority: 'normal' as const,
      metadata: { 'bad\nkey': 'value' },
    };
    expect(() => encodeOutbox(msg)).toThrow(/unsafe/i);
  });
});

