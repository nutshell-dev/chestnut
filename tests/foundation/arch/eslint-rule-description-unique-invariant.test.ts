import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 636: invariant that every chestnut-custom ESLint rule's
 * `meta.docs.description` is unique — no two rules share the same
 * description.
 *
 * Rationale (ML#3 single-source semantics): each rule's description is
 * the SoT for that rule's purpose (shown in IDE hover hints + lint
 * report). Drift breaks invisibly when copy-paste leaves two rules
 * sharing a description:
 * - IDE hover hint identifies different rules with same text
 * - delete one rule but description was the working SoT for another →
 *   intent lost on the survivor
 *
 * Mirrors phase 635 (depcruise comment uniqueness) for the ESLint
 * description surface. Pairs with phase 603 (description non-empty),
 * phase 617 (messageId camelCase), phase 607 (messageId set-equivalence).
 */
describe('ESLint rule description uniqueness invariant (phase 636)', () => {
  it('every rule meta.docs.description is unique', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { docs?: { description?: string } } };
      };
      const desc = mod?.default?.meta?.docs?.description ?? '';
      if (seen.has(desc)) {
        duplicates.push(`${f} ↔ ${seen.get(desc)} (shared: ${desc.slice(0, 60)}…)`);
      } else {
        seen.set(desc, f);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
