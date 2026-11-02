import { describe, expect, it } from 'vitest';
import {
  createSendContentTracker,
  feedSendContentDelta,
} from '../../../src/foundation/messaging/tools/send-content-extractor.js';

function feedAll(parts: string[]): string {
  const tracker = createSendContentTracker();
  let out = '';
  for (const part of parts) {
    out += feedSendContentDelta(tracker, part) ?? '';
  }
  return out;
}

describe('send content extractor JSON decoding', () => {
  it('decodes plain ASCII content without escapes', () => {
    expect(feedAll(['{"content":"hello chestnut"}'])).toBe('hello chestnut');
  });

  it('decodes every standard JSON string escape', () => {
    expect(feedAll(['{"content":"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti"}']))
      .toBe('a"b\\c/d\be\ff\ng\rh\ti');
  });

  it('decodes unicode escapes into CJK characters', () => {
    expect(feedAll(['{"content":"\\u4f60\\u597d\\uff01"}'])).toBe('你好！');
  });

  it('decodes a UTF-16 surrogate pair into one astral character', () => {
    const out = feedAll(['{"content":"\\ud83d\\udc4b"}']);
    expect(out).toBe('👋');
    expect([...out]).toHaveLength(1);
  });

  it('preserves isolated surrogate code units', () => {
    expect(feedAll(['{"content":"\\ud83d!\\udc4b"}']))
      .toBe(`${String.fromCharCode(0xd83d)}!${String.fromCharCode(0xdc4b)}`);
  });

  it('does not decode a unicode escape hidden behind an escaped backslash', () => {
    expect(feedAll(['{"content":"\\\\u4f60"}'])).toBe('\\u4f60');
  });

  it('keeps quotes and braces in mixed content', () => {
    expect(feedAll(['{"content":"say \\"hi\\" } and } more}"}']))
      .toBe('say "hi" } and } more}');
  });

  it('keeps malformed and unknown escapes lenient without throwing', () => {
    expect(feedAll(['{"content":"a\\u12x4b\\qc"}'])).toBe('au12x4bqc');
  });

  it('emits nothing until the content prefix is present', () => {
    expect(feedAll(['{"name":"send"'])).toBe('');
  });
});
