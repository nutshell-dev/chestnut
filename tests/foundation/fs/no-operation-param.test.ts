import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('fs/node-fs.ts: no _operation param', () => {
  it('resolveAndCheck does not take _operation parameter', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    expect(src).not.toMatch(/_operation/);
  });

  it('types.ts does not reference _operation', () => {
    const src = readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).not.toMatch(/_operation/);
  });
});
