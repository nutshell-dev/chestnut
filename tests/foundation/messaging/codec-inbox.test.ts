import { describe, it, expect } from 'vitest';
import { encodeInbox, decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { parseFrontmatter } from '../../../src/foundation/messaging/codec-inbox.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';

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
