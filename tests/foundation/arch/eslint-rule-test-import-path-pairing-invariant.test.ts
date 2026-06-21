import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 628: invariant that every chestnut-custom rule test file imports
 * its rule via `from '../../../.config/eslint-rules/<basename>.js'`
 * where `<basename>` exactly matches the test file's basename (without
 * `.test.ts`).
 *
 * Rationale (ML#9 explicit coupling): the test file basename + the
 * imported rule's basename must stay synchronized. Drift breaks at test
 * load:
 * - rename rule file but forget test import → import fail loud at test
 *   collection, but only when running that suite
 * - typo in either path → same shape
 *
 * Adds a finer-grained guard layer on top of phase 580 (1:1 file pairing)
 * + phase 606 (ruleTester.run name === basename).
 *
 * Pairs with phase 606 (run name), phase 580 (file 1:1), phase 587
 * (RuleTester usage), phase 605 (valid/invalid non-empty).
 */
describe('ESLint rule test import path pairing invariant (phase 628)', () => {
  it('every test file imports rule from matching basename path', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const offenders: string[] = [];
    const importRe = /from\s+['"]\.\.\/\.\.\/\.\.\/\.config\/eslint-rules\/([^'"]+)\.js['"]/;
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      const basename = f.replace(/\.test\.ts$/, '');
      const m = text.match(importRe);
      if (!m) {
        offenders.push(`${f}: no '../../../.config/eslint-rules/<x>.js' import`);
        continue;
      }
      if (m[1] !== basename) {
        offenders.push(`${f}: imports '${m[1]}.js' (expected '${basename}.js')`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
