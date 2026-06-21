import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 663: invariant that every chestnut-custom rule has
 * `meta.docs.category === 'Best Practices'`.
 *
 * Rationale (ML#3 single-source classification): chestnut-custom rules
 * are architectural constraints — Best Practices category. They are NOT
 * Possible Errors (runtime-error-class) or Stylistic Issues (cosmetic).
 * Drift breaks invisibly:
 * - IDE rule browsers / filters group rules by category; mis-classified
 *   rules invisible under expected filter
 * - lint report grouping mismatches user expectation
 *
 * Pairs with phase 596 (meta.type='problem'), phase 597 (structural
 * quartet), phase 598 (应然 marker), phase 603 (description non-empty).
 */
describe('ESLint rule meta.docs.category invariant (phase 663)', () => {
  it('every rule has meta.docs.category === "Best Practices"', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { docs?: { category?: string } } };
      };
      const cat = mod?.default?.meta?.docs?.category;
      if (cat !== 'Best Practices') {
        offenders.push(`${f}: category=${String(cat)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
