import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 600: invariant that every package.json script whose name starts with
 * `test` references `--config .config/vitest.config.ts`.
 *
 * Rationale (ML#3 single-source ownership): the vitest configuration SoT
 * lives at `.config/vitest.config.ts`, not at repo root. Any test script
 * missing the explicit `--config` flag falls back to vitest's default config
 * resolution (which searches for `vitest.config.ts` / `vite.config.ts` at
 * repo root), creating a silent split between two configs that drift
 * independently.
 *
 * Pairs with phase 597 (ESLint rule structural completeness), phase 595
 * (forbidden rule from.path), phase 580 (rule ↔ test pairing).
 */
describe('package.json test* script vitest.config.ts SoT invariant (phase 600)', () => {
  it('every script named test* references --config .config/vitest.config.ts', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };

    const testScripts = Object.entries(pkg.scripts).filter(([name]) =>
      name.startsWith('test'),
    );

    expect(testScripts.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [name, value] of testScripts) {
      if (!value.includes('--config .config/vitest.config.ts')) {
        missing.push(`${name}: ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
