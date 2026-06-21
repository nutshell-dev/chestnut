import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 580: invariant test that every ESLint custom rule has a corresponding
 * RuleTester unit test, and vice versa (strict 1:1 pairing).
 *
 * Convention:
 *   .config/eslint-rules/<rule-name>.js  ↔  tests/foundation/eslint-rules/<rule-name>.test.ts
 *
 * Established by phase 309 ESLint infra + per-rule commit-time pairing.
 * Prevents future drift where a new rule is added but tests slip OR a test
 * outlives its rule.
 */
describe('ESLint custom rule ↔ test pairing invariant (phase 580)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const rulesDir = path.join(repoRoot, '.config', 'eslint-rules');
  const testsDir = path.join(repoRoot, 'tests', 'foundation', 'eslint-rules');

  it('every rule file has a matching test file (and no orphan tests)', () => {
    const ruleBasenames = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .map(f => f.slice(0, -3))
      .sort();
    const testBasenames = fs
      .readdirSync(testsDir)
      .filter(f => f.endsWith('.test.ts'))
      .map(f => f.slice(0, -8))
      .sort();

    const rulesMissingTests = ruleBasenames.filter(r => !testBasenames.includes(r));
    const testsMissingRules = testBasenames.filter(t => !ruleBasenames.includes(t));

    expect(rulesMissingTests).toEqual([]);
    expect(testsMissingRules).toEqual([]);
  });
});
