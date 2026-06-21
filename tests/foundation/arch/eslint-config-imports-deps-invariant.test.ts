import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 646: invariant that every non-local import in .config/eslint.config.js
 * resolves to a package in package.json (dependencies ∪ devDependencies).
 *
 * Rationale (ML#9 explicit coupling): config literal imports + package.json
 * deps are an inescapable coupling. Drift breaks at runtime:
 * - add new plugin import but forget deps → install succeeds, `pnpm
 *   lint:lint` throws `Cannot find module` at config load
 * - remove deps but config keeps import → same throw
 *
 * One-way: config → package.json. Reverse (deps not used in config)
 * is covered by phase 511 no-unused-node-modules depcruise rule.
 *
 * Normalizes import specifiers to package roots:
 * - `pkg` → `pkg`
 * - `pkg/sub/path` → `pkg`
 * - `@scope/name/sub` → `@scope/name`
 *
 * Pairs with phase 616 (eslint config languageOptions baseline), phase
 * 591 (3-way rule pairing), phase 511 (no-unused-node-modules).
 */
describe('eslint.config imports ⊆ package deps invariant (phase 646)', () => {
  it('every non-local import resolves to package.json dep', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const cfgText = fs.readFileSync(
      path.join(repoRoot, '.config/eslint.config.js'),
      'utf-8',
    );
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

    const importRe = /^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
    const offenders: string[] = [];
    const toPkgRoot = (spec: string): string => {
      if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.slice(0, 2).join('/');
      }
      return spec.split('/')[0];
    };

    let m: RegExpExecArray | null;
    while ((m = importRe.exec(cfgText)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.')) continue; // local import
      const pkgRoot = toPkgRoot(spec);
      if (!allDeps.has(pkgRoot)) {
        offenders.push(`${spec} (root=${pkgRoot}) not in package.json deps`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
