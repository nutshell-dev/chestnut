import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('foundation/stream/writer.ts: uses FileSystem', () => {
  // negative `from 'fs' | 'node:fs'` import 由 depcruise `fs-only-via-foundation-filesystem` enforce (phase 363)

  it('uses FileSystem.writeExclusiveSync for session boundary init', () => {
    const src = readFileSync('src/foundation/stream/writer.ts', 'utf-8');
    expect(src).toMatch(/writeExclusiveSync\(/);
  });
});
