import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 672: invariant that every chestnut-custom rule test file's
 * first describe block label starts with 'eslint custom rule'.
 *
 * Rationale (ML#3 single-source naming): rule test describe label is
 * the SoT for the chestnut-custom test set in vitest output. Drift to
 * other labels:
 * - grep 'eslint custom rule' from vitest output no longer locates the
 *   subset, debugging becomes guesswork
 * - test-set filtering by label fragments
 *
 * phase 583 covers arch test describe containing phase NNN; this phase
 * pins the specific prefix for rule tests (complementary).
 *
 * Pairs with phase 583 (arch test phase NNN reference), phase 585
 * (rule + test phase reference), phase 606 (run name === basename),
 * phase 671 (no vi.mock).
 */
describe('ESLint rule test describe label invariant (phase 672)', () => {
  it('every rule test starts with describe("eslint custom rule', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const re = /describe\(\s*['"]eslint custom rule/;
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      if (!re.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
