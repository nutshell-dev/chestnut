import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 605: invariant that every chestnut-custom ESLint rule test file in
 * tests/foundation/eslint-rules/*.test.ts has non-empty `valid:` AND
 * `invalid:` arrays in its RuleTester invocation.
 *
 * Rationale: RuleTester requires both coverage sides:
 * - empty `valid:` → rule may over-fire on legitimate code, untested
 * - empty `invalid:` → rule may never trigger, broken-by-default passes
 *   silently (test pseudo-green / 测试伪绿)
 *
 * Both sides non-empty is the threshold for RuleTester to verify real
 * coverage. Pairs with phase 587 (RuleTester usage), phase 580 (rule ↔ test
 * 1:1), phase 585 (rule + test phase NNN).
 */
describe('ESLint rule test valid/invalid non-empty invariant (phase 605)', () => {
  it('every rule test file has non-empty valid AND invalid arrays', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const offenders: string[] = [];
    const emptyArrayRe = (key: string) => new RegExp(`${key}:\\s*\\[\\s*\\]`);
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      if (emptyArrayRe('valid').test(text)) offenders.push(`${f}: empty valid`);
      if (emptyArrayRe('invalid').test(text)) offenders.push(`${f}: empty invalid`);
    }
    expect(offenders).toEqual([]);
  });
});
