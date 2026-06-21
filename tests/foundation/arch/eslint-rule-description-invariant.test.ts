import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 603: invariant that every chestnut-custom ESLint rule under
 * .config/eslint-rules/*.js has `meta.docs.description` as a non-empty
 * trimmed string.
 *
 * Rationale: meta.docs.description is the SoT for IDE hover hints +
 * human-readable lint report messages. Empty / missing description → the
 * developer sees the rule fire but no explanation of intent → rule decays
 * into a black-box "punish but don't tell you why" punisher.
 *
 * Extends phase 597 (meta.docs presence) with content-level non-empty
 * constraint. Pairs with phase 598 (应然 marker in header), phase 596
 * (meta.type='problem'), phase 593 (severity='error').
 */
describe('ESLint chestnut-custom rule description invariant (phase 603)', () => {
  it('every rule has meta.docs.description as non-empty string', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { docs?: { description?: unknown } } };
      };
      const desc = mod?.default?.meta?.docs?.description;
      if (typeof desc !== 'string' || desc.trim().length === 0) {
        offenders.push(`${f}: description=${String(desc)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
