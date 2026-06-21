import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 664: invariant that every chestnut-custom rule's `meta.docs`
 * has exactly the keys {description, category} — no extra fields like
 * url, recommended, requiresTypeChecking, etc.
 *
 * Rationale (ML#3 single-source docs shape): chestnut-custom rule docs
 * structure should be uniform (description + category). Additional
 * optional fields (url, recommended) — if needed — should be added
 * across all rules in one phase + accompanied by their own invariant,
 * not ad-hoc per-rule additions that fragment docs shape.
 *
 * Pairs with phase 597 (structural quartet), phase 603 (description
 * non-empty), phase 663 (category = 'Best Practices'), phase 636
 * (description uniqueness).
 */
describe('ESLint rule meta.docs keys strict invariant (phase 664)', () => {
  it('every meta.docs has exactly keys {description, category}', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const EXPECTED = ['category', 'description'];
    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { docs?: Record<string, unknown> } };
      };
      const docs = mod?.default?.meta?.docs ?? {};
      const actual = Object.keys(docs).sort();
      if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
        offenders.push(`${f}: keys=${actual.join(',')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
