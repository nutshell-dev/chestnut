import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 666: invariant that every chestnut-custom rule's default export
 * has exactly {meta, create} as keys — no extra fields like
 * defaultOptions, configs, etc.
 *
 * Rationale (ML#3 single-source export shape): rule export is the
 * outermost ESLint loading surface. Structure must be uniform. Any
 * extra field should be added across all rules in one phase + own
 * invariant.
 *
 * Mirrors phase 664 (meta.docs keys strict) + phase 665 (meta keys
 * strict) at the default export layer above. Together these 3 phases
 * pin all 3 levels of rule structure.
 *
 * Pairs with phase 597 (structural quartet — presence), phase 596
 * (meta.type='problem'), phase 665 (meta keys strict).
 */
describe('ESLint rule export keys strict invariant (phase 666)', () => {
  it('every default export has exactly keys {meta, create}', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const EXPECTED = ['create', 'meta'];
    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: Record<string, unknown>;
      };
      const exp = mod?.default ?? {};
      const actual = Object.keys(exp).sort();
      if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
        offenders.push(`${f}: keys=${actual.join(',')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
