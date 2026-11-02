import { describe, expect, it } from 'vitest';
import {
  createSendContentTracker,
  feedSendContentDelta,
} from '../../../src/foundation/messaging/tools/send-content-extractor.js';

function toJsonEscaped(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp > 0xffff) {
      const value = cp - 0x10000;
      out += `\\u${(0xd800 + (value >> 10)).toString(16)}`;
      out += `\\u${(0xdc00 + (value & 0x3ff)).toString(16)}`;
    } else if (cp > 0x7f) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
    } else {
      out += JSON.stringify(ch).slice(1, -1);
    }
  }
  return out;
}

function feedAll(parts: string[]): { output: string; deltas: string[] } {
  const tracker = createSendContentTracker();
  const deltas: string[] = [];
  for (const part of parts) {
    const delta = feedSendContentDelta(tracker, part);
    if (delta !== null) deltas.push(delta);
  }
  return { output: deltas.join(''), deltas };
}

describe('send content extractor streaming escape boundaries', () => {
  const text = '你好！👋\n"quoted" \\ path } tail}';
  const payload = `{"content":"${toJsonEscaped(text)}"}`;

  it('matches one-shot output at every two-chunk split point', () => {
    const expected = feedAll([payload]).output;
    expect(expected).toBe(text);
    for (let cut = 0; cut <= payload.length; cut += 1) {
      const actual = feedAll([payload.slice(0, cut), payload.slice(cut)]).output;
      expect(actual, `split at ${cut}`).toBe(expected);
    }
  });

  it('matches one-shot output across sampled three-chunk splits', () => {
    for (let first = 1; first < payload.length; first += 5) {
      for (let second = first; second < payload.length; second += 9) {
        const actual = feedAll([
          payload.slice(0, first),
          payload.slice(first, second),
          payload.slice(second),
        ]).output;
        expect(actual, `splits at ${first}/${second}`).toBe(text);
      }
    }
  });

  it('matches one-shot output with three-character fragments', () => {
    const parts: string[] = [];
    for (let i = 0; i < payload.length; i += 3) {
      parts.push(payload.slice(i, i + 3));
    }
    expect(feedAll(parts).output).toBe(text);
  });

  it('holds a unicode escape until all four hex digits arrive', () => {
    const tracker = createSendContentTracker();
    expect(feedSendContentDelta(tracker, '{"content":"\\u4f')).toBeNull();
    expect(feedSendContentDelta(tracker, '60"}')).toBe('你');
  });

  it('holds split quote and backslash escapes', () => {
    expect(feedAll(['{"content":"a\\', '"b"}']).output).toBe('a"b');
    expect(feedAll(['{"content":"a\\', '\\b"}']).output).toBe('a\\b');
  });

  it('reassembles a surrogate pair split between its escapes', () => {
    const result = feedAll(['{"content":"\\ud83d', '\\udc4b"}']);
    expect(result.output).toBe('👋');
    expect([...result.output]).toHaveLength(1);
  });

  it.each(['\\u', '\\u4', '\\u4f'])(
    'flushes incomplete escape %s literally after content closes',
    (escape) => {
      expect(feedAll([`{"content":"before${escape}"}`]).output)
        .toBe(`before${escape}`);
    },
  );
});
