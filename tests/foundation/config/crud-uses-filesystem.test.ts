import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('assembly/config-load: uses FileSystem for atomic writes', () => {
  // negative `fs.writeFileSync` callsite implied 0 by depcruise `fs-only-via-foundation-filesystem`
  // (blocks `import from 'fs' | 'node:fs'` → callsite impossible) (phase 363)

  it('contains no Date.now() tmp naming', () => {
    const src = readFileSync('src/assembly/config-load.ts', 'utf-8');
    expect(src).not.toMatch(/\$\{Date\.now\(\)\}/);
  });

  it('uses writeAtomicSync for config writes', () => {
    const configLoadSrc = readFileSync('src/assembly/config-load.ts', 'utf-8');
    const loaderSrc = readFileSync('src/foundation/config/loader.ts', 'utf-8');
    // Phase 10/298: write logic remains in loader.ts; config-load.ts delegates via writeYamlConfig
    expect(configLoadSrc + loaderSrc).toMatch(/writeAtomicSync\(/);
  });
});
