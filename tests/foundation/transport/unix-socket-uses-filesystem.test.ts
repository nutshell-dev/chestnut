import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('foundation/transport/unix-socket.ts: uses FileSystem', () => {
  // negative `from 'node:fs' | 'fs'` import 由 depcruise `fs-only-via-foundation-filesystem` enforce (phase 363)

  it('references FileSystem type', () => {
    const src = readFileSync('src/foundation/transport/unix-socket.ts', 'utf-8');
    expect(src).toMatch(/FileSystem/);
  });

  it('uses deps.fs.delete for socket cleanup', () => {
    const src = readFileSync('src/foundation/transport/unix-socket.ts', 'utf-8');
    expect(src).toMatch(/deps\.fs\.delete\(/);
  });
});
