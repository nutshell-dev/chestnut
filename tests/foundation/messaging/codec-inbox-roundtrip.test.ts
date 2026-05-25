import { describe, it, expect } from 'vitest';
import { encodeInbox, decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { InboxMessage } from '../../../src/foundation/messaging/types.js';

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
