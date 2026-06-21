import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 606: invariant that every chestnut-custom rule test file's
 * `ruleTester.run('<name>', ...)` first argument matches the test file
 * basename (basename of `<name>.test.ts`).
 *
 * Rationale (ML#3 single-source naming): the RuleTester run name appears in
 * RuleTester failure output. Mismatched name → developer sees report text
 * naming the wrong rule, misdiagnoses scope (e.g. fail says 'no-foo' but
 * the test actually verifies 'no-bar' rule).
 *
 * Pairs with phase 580 (rule ↔ test 1:1), phase 587 (RuleTester usage),
 * phase 591 (3-way pairing), phase 605 (valid/invalid non-empty).
 */
describe('ESLint rule test ruleTester.run name === basename invariant (phase 606)', () => {
  it('every test file ruleTester.run() first arg matches basename', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const offenders: string[] = [];
    const runArgRe = /ruleTester\.run\(\s*['"]([^'"]+)['"]/;
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      const m = text.match(runArgRe);
      const basename = f.replace(/\.test\.ts$/, '');
      if (!m) {
        offenders.push(`${f}: no ruleTester.run('<name>', ...) found`);
        continue;
      }
      const runName = m[1];
      if (runName !== basename) {
        offenders.push(`${f}: runName='${runName}' !== basename='${basename}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
