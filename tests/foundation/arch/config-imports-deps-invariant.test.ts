import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 647: invariant that every non-local non-node-built-in import in
 * .config/tsup.config.ts, .config/vitest.config.ts, and
 * .config/vitest-setup.ts resolves to a package in package.json
 * (dependencies ∪ devDependencies).
 *
 * Extends phase 646 (eslint.config.js → deps) to cover the remaining
 * config TS files. Same coupling: config literal imports + package.json
 * deps. Drift breaks at config load:
 * - add new package import but forget deps → install succeeds, `pnpm
 *   build` / `pnpm test:run` throws Cannot find module
 * - remove deps but config keeps import → same throw
 *
 * Skips:
 * - `./`, `../` (local imports)
 * - `node:*` (built-in modules; not in package.json)
 * - vitest-global-setup.ts (only node built-ins, no external deps)
 * - dependency-cruiser.cjs (uses module.exports, no imports)
 *
 * Pairs with phase 646 (eslint.config imports → deps), phase 511
 * (no-unused-node-modules — reverse direction).
 */
describe('config files imports ⊆ package deps invariant (phase 647)', () => {
  it('every non-local non-builtin import resolves to package.json dep', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const CONFIG_FILES = [
      '.config/tsup.config.ts',
      '.config/vitest.config.ts',
      '.config/vitest-setup.ts',
    ];

    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const toPkgRoot = (spec: string): string => {
      if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.slice(0, 2).join('/');
      }
      return spec.split('/')[0];
    };

    const importRe = /^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
    const offenders: string[] = [];
    for (const f of CONFIG_FILES) {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(text)) !== null) {
        const spec = m[1];
        if (spec.startsWith('.')) continue; // local
        if (spec.startsWith('node:')) continue; // built-in
        const pkgRoot = toPkgRoot(spec);
        if (!allDeps.has(pkgRoot)) {
          offenders.push(`${f}: ${spec} (root=${pkgRoot}) not in deps`);
        }
      }
      importRe.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});
