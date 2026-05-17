import { describe, it, expect } from 'vitest';
import { encodeInbox, decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { InboxMessage } from '../../../src/types/messaging.js';

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
    const msg: InboxMessage = { ...base, from: 'foo\nbar', contract_id: 'line1\r\nline2' };
    const encoded = encodeInbox(msg);
    const decoded = decodeInbox(encoded);
    expect(decoded.from).toBe('foo\nbar');
    expect(decoded.contract_id).toBe('line1\r\nline2');
  });

  it('round-trip value with `\\\\` + `"` + literal `\\n` text preserves verbatim (反向 3: NUL placeholder collision-safe)', () => {
    const msg: InboxMessage = {
      ...base,
      from: 'path\\to\\file',
      extraMeta: { note: 'said "hi"', escaped: 'literal \\n stays' },
    };
    const encoded = encodeInbox(msg);
    const decoded = decodeInbox(encoded);
    expect(decoded.from).toBe('path\\to\\file');
    expect(decoded.extraMeta?.note).toBe('said "hi"');
    expect(decoded.extraMeta?.escaped).toBe('literal \\n stays');
  });
});
