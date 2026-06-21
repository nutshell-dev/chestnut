import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 673: invariant that every chestnut-custom rule test file uses
 * the canonical import form:
 *
 *   import { RuleTester } from 'eslint';
 *
 * Rationale (ML#3 single-source import form): rule test import form
 * must be uniform for grep / refactor reliability. Drift to
 * `import * as eslint from 'eslint'; eslint.RuleTester`, namespace
 * aliases, or destructured renames fragments search/replace.
 *
 * phase 587 covers test contains 'RuleTester' literal; this phase pins
 * the exact import line, complementary.
 *
 * Pairs with phase 587 (RuleTester usage required), phase 671 (no
 * vi.mock), phase 672 (describe label), phase 628 (rule import path).
 */
const CANONICAL = "import { RuleTester } from 'eslint';";

describe('ESLint rule test canonical RuleTester import invariant (phase 673)', () => {
  it('every rule test contains canonical import line', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      if (!text.includes(CANONICAL)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
