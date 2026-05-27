import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('foundation/stream/writer.ts: uses FileSystem', () => {
  it('does not import from fs directly', () => {
    const src = readFileSync('src/foundation/stream/writer.ts', 'utf-8');
    expect(src).not.toMatch(/from\s+['"]fs['"]/);
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
  });

  it('uses FileSystem.writeExclusiveSync for session boundary init', () => {
    const src = readFileSync('src/foundation/stream/writer.ts', 'utf-8');
    expect(src).toMatch(/writeExclusiveSync\(/);
  });
});
