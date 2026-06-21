import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 618: invariant that tsconfig.json source/output scope is:
 * - include === ['src/**\/*']
 * - exclude === ['node_modules', 'dist', 'tests']
 * - compilerOptions.rootDir === './src'
 * - compilerOptions.outDir === './dist'
 *
 * Rationale (ML#3 single-source scope):
 * - include drift to include tests → tsc reports errors on test fixtures
 *   that intentionally violate strict-family rules
 * - exclude drift drops 'tests' → same surface
 * - rootDir drift → dist structure changes (relative path origin moves) →
 *   published package paths break
 * - outDir drift → tsc and tsup write to different dirs → CI / publish
 *   races
 *
 * Pairs with phase 608 (strict-family flags), phase 615 (depcruise
 * options), phase 612/613 (package.json / tsup).
 */
describe('tsconfig.json scope baseline invariant (phase 618)', () => {
  it('include/exclude/rootDir/outDir match baseline', () => {
    const cfgPath = path.resolve(__dirname, '../../../tsconfig.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      include?: unknown;
      exclude?: unknown;
      compilerOptions?: { rootDir?: unknown; outDir?: unknown };
    };
    expect(cfg.include).toEqual(['src/**/*']);
    expect(cfg.exclude).toEqual(['node_modules', 'dist', 'tests']);
    expect(cfg.compilerOptions?.rootDir).toBe('./src');
    expect(cfg.compilerOptions?.outDir).toBe('./dist');
  });
});
