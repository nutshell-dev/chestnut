import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('foundation/config/crud.ts: uses FileSystem for atomic writes', () => {
  it('contains no inline fs.writeFileSync for atomic write pattern', () => {
    const src = readFileSync('src/foundation/config/crud.ts', 'utf-8');
    expect(src).not.toMatch(/fs\.writeFileSync\b/);
  });

  it('contains no Date.now() tmp naming', () => {
    const src = readFileSync('src/foundation/config/crud.ts', 'utf-8');
    expect(src).not.toMatch(/\$\{Date\.now\(\)\}/);
  });

  it('uses writeAtomicSync for config writes', () => {
    const src = readFileSync('src/foundation/config/crud.ts', 'utf-8');
    expect(src).toMatch(/writeAtomicSync\(/);
  });
});
