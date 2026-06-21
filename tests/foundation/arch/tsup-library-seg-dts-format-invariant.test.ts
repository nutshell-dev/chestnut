import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 630: invariant that tsup library segment (entry contains 'index')
 * has `dts: true` AND `format` contains both 'esm' and 'cjs'.
 *
 * Rationale (ML#9 explicit coupling): tsup library seg config is the
 * counterpart of package.json types/main/module fields:
 * - package.json types=./dist/index.d.ts ⇒ library seg must have dts:true
 *   (otherwise npm publish ships package without .d.ts; TS consumers lose
 *   types silently)
 * - package.json main=./dist/index.cjs ⇒ library seg must format includes
 *   'cjs' (otherwise the CJS main path points at non-existent file;
 *   require() throws for CJS consumers)
 * - package.json module=./dist/index.js ⇒ library seg must format
 *   includes 'esm' (otherwise ESM import path missing)
 *
 * Extends phase 629 (CLI banner/sourcemap/clean) + phase 613 (package ↔
 * tsup pairing) to the library-seg specific dist artifact shape.
 */
type TsupSeg = {
  entry: Record<string, string>;
  dts?: boolean;
  format?: string[];
};

describe('tsup library seg dts + format invariant (phase 630)', () => {
  it('library seg (entry index) has dts=true + format includes esm+cjs', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgPath = path.join(repoRoot, '.config/tsup.config.ts');
    const mod = (await import(cfgPath)) as { default?: unknown };
    const raw = mod.default;
    const segs: TsupSeg[] = Array.isArray(raw) ? (raw as TsupSeg[]) : [];
    expect(segs.length).toBeGreaterThan(0);

    const librarySeg = segs.find(s => s.entry && 'index' in s.entry);
    expect(librarySeg).toBeDefined();
    const ls = librarySeg as TsupSeg;
    expect(ls.dts).toBe(true);
    const formats = ls.format ?? [];
    expect(formats).toContain('esm');
    expect(formats).toContain('cjs');
  });
});
