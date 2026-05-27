import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('foundation/transport/unix-socket.ts: uses FileSystem', () => {
  it('does not import from node:fs or fs directly', () => {
    const src = readFileSync('src/foundation/transport/unix-socket.ts', 'utf-8');
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(src).not.toMatch(/from\s+['"]fs['"]/);
  });

  it('references FileSystem type', () => {
    const src = readFileSync('src/foundation/transport/unix-socket.ts', 'utf-8');
    expect(src).toMatch(/FileSystem/);
  });

  it('uses deps.fs.delete for socket cleanup', () => {
    const src = readFileSync('src/foundation/transport/unix-socket.ts', 'utf-8');
    expect(src).toMatch(/deps\.fs\.delete\(/);
  });
});
