import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 612: invariant that package.json entry points all reference
 * `./dist/*` build outputs (not source-tree paths) and `type === 'module'`.
 *
 * Rationale (ML#3 single-source publishing):
 * - main / module / types / bin / exports['.'] are the distribution surface.
 *   A path pointing at `./src/*` after npm publish would mean users install
 *   a package that imports TS source they can't run.
 * - `type: 'module'` decides .js parse mode. Drift to 'commonjs' flips every
 *   ESM import → require, breaking ESM-only deps.
 *
 * Pairs with phase 611 (vitest exclude base), phase 610 (project names),
 * phase 608 (tsconfig strict).
 */
describe('package.json entry points invariant (phase 612)', () => {
  it('type=module + all dist-prefixed entry paths', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      type?: unknown;
      main?: unknown;
      module?: unknown;
      types?: unknown;
      bin?: Record<string, unknown>;
      exports?: Record<string, Record<string, unknown>>;
    };

    expect(pkg.type).toBe('module');

    const entries: Array<{ name: string; value: unknown }> = [
      { name: 'main', value: pkg.main },
      { name: 'module', value: pkg.module },
      { name: 'types', value: pkg.types },
      { name: 'bin.chestnut', value: pkg.bin?.chestnut },
      { name: 'exports["."].import', value: pkg.exports?.['.']?.import },
      { name: 'exports["."].require', value: pkg.exports?.['.']?.require },
    ];

    const offenders: string[] = [];
    for (const { name, value } of entries) {
      if (typeof value !== 'string' || !value.startsWith('./dist/')) {
        offenders.push(`${name}=${String(value)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
