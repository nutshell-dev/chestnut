import { describe, it, expect } from 'vitest';
import { parseFrontmatterFrame } from '../../../src/foundation/messaging/frontmatter-frame.js';

describe('parseFrontmatterFrame', () => {
  it('parses standard frontmatter', () => {
    const r = parseFrontmatterFrame('---\nname: foo\nver: 1.0\n---\nhello');
    expect(r.meta).toEqual({ name: 'foo', ver: '1.0' });
    expect(r.body).toBe('hello');
  });

  it('does NOT unquote values (caller responsibility)', () => {
    const r = parseFrontmatterFrame('---\nq: "bar"\n---\nbody');
    expect(r.meta.q).toBe('"bar"');
  });

  it('returns empty meta + raw body when no opener', () => {
    const r = parseFrontmatterFrame('plain text');
    expect(r.meta).toEqual({});
    expect(r.body).toBe('plain text');
  });

  it('normalizes CRLF to LF', () => {
    const r = parseFrontmatterFrame('---\r\nname: foo\r\n---\r\nbody');
    expect(r.meta.name).toBe('foo');
    expect(r.body).toBe('body');
  });

  it('splits on first colon only', () => {
    const r = parseFrontmatterFrame('---\nurl: http://x.io/path\n---\n');
    expect(r.meta.url).toBe('http://x.io/path');
  });

  it('skips lines with leading colon (ci <= 0)', () => {
    const r = parseFrontmatterFrame('---\n:bad\nname: foo\n---\n');
    expect(r.meta).toEqual({ name: 'foo' });
  });

  it('handles empty frontmatter block', () => {
    const r = parseFrontmatterFrame('---\n---\nbody');
    expect(r.meta).toEqual({});
    expect(r.body).toBe('body');
  });

  it('throws on malformed (no closer)', () => {
    expect(() => parseFrontmatterFrame('---\nname: foo\nno closing'))
      .toThrow(/Malformed frontmatter/);
  });

  it('throws on EOF \\n--- without eofTolerant opt', () => {
    expect(() => parseFrontmatterFrame('---\nname: foo\n---'))
      .toThrow(/Malformed frontmatter/);
  });

  it('accepts EOF \\n--- when eofTolerant=true (phase 953)', () => {
    const r = parseFrontmatterFrame('---\nname: foo\n---', { eofTolerant: true });
    expect(r.meta.name).toBe('foo');
    expect(r.body).toBe('');
  });

  it('trims body whitespace', () => {
    const r = parseFrontmatterFrame('---\nname: foo\n---\n\n  hello world  \n\n');
    expect(r.body).toBe('hello world');
  });

  it('trims key/value whitespace', () => {
    const r = parseFrontmatterFrame('---\n  name  :   foo   \n---\nbody');
    expect(r.meta.name).toBe('foo');
  });
});
