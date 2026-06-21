import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 661: invariant that every chestnut-custom rule's
 * `meta.docs.description` is at least 20 characters long.
 *
 * Rationale: description is the SoT for IDE hover hint + lint report
 * narrative. Trivial description like 'rule x' leaves user knowing only
 * that the rule fired, not why or how to fix.
 *
 * Loose floor (20 chars) — current shortest is 59 chars; catches
 * accidental trim/clip without dictating long-form prose.
 *
 * Mirrors phase 660 (depcruise rule comment length ≥ 30) for the ESLint
 * description surface. Pairs with phase 603 (non-empty), phase 636
 * (unique).
 */
describe('ESLint rule description length invariant (phase 661)', () => {
  it('every meta.docs.description length ≥ 20', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { docs?: { description?: string } } };
      };
      const desc = mod?.default?.meta?.docs?.description ?? '';
      if (desc.length < 20) {
        offenders.push(`${f} (len=${desc.length})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
