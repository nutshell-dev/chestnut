import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 671: invariant that no ESLint rule test file uses `vi.mock` or
 * `vi.fn(`.
 *
 * Rationale (ML#3 single-source test method): rule tests use ESLint's
 * `RuleTester` as the SoT. Layering vitest mocks on top:
 * - double abstraction breaks mock isolation guarantees
 * - vi.mock introduces hidden dependency on the mocked real module;
 *   rule behavior detaches from real ESLint runtime
 *
 * Pairs with phase 587 (RuleTester usage required), phase 605
 * (valid/invalid non-empty), phase 606 (ruleTester.run name === basename),
 * phase 628 (test import path pairing).
 */
describe('ESLint rule test no vi.mock/vi.fn invariant (phase 671)', () => {
  it('no rule test file uses vi.mock or vi.fn(', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      if (/\bvi\.mock\b/.test(text)) offenders.push(`${f}: vi.mock`);
      if (/\bvi\.fn\(/.test(text)) offenders.push(`${f}: vi.fn(`);
    }
    expect(offenders).toEqual([]);
  });
});
