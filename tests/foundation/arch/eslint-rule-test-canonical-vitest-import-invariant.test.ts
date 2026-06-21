import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 674: invariant that every chestnut-custom rule test file uses
 * the canonical vitest import form:
 *
 *   import { describe, it } from 'vitest';
 *
 * Rationale (ML#3 single-source import form): rule tests don't need
 * `expect` (RuleTester contains internal assertions) or `vi` (phase 671
 * bans vi.mock). The canonical import is `{describe, it}` only.
 *
 * Mirrors phase 673 (canonical RuleTester import) to the vitest import
 * side.
 *
 * Pairs with phase 673 (canonical RuleTester import), phase 671 (no
 * vi.mock), phase 672 (describe label), phase 587 (RuleTester usage).
 */
const CANONICAL_VITEST = "import { describe, it } from 'vitest';";

describe('ESLint rule test canonical vitest import invariant (phase 674)', () => {
  it('every rule test contains canonical vitest import', () => {
    const testDir = path.resolve(__dirname, '../../../tests/foundation/eslint-rules');
    const files = fs
      .readdirSync(testDir)
      .filter(f => f.endsWith('.test.ts'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(testDir, f), 'utf-8');
      if (!text.includes(CANONICAL_VITEST)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
