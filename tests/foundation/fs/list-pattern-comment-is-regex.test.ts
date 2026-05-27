import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('fs/types.ts: list pattern comment accuracy', () => {
  it('does not contain "glob pattern" comment', () => {
    const src = readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).not.toMatch(/glob pattern/);
  });

  it('contains "regular expression pattern" comment', () => {
    const src = readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).toMatch(/regular expression pattern/);
  });
});
