import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 669: invariant that every chestnut-custom rule has
 * `meta.schema === []` (empty array — no user options accepted).
 *
 * Rationale (ML#3 single-source rule config): chestnut-custom rules are
 * repo-internal — caller doesn't customize them. Introducing schema:
 * - allows eslint.config.js to pass options per call site → double SoT
 *   (rule source + config) → complexity explosion
 * - i18n / mock contexts become harder
 *
 * phase 597 covers schema presence (any value); this phase pins it to
 * the empty-array default, complementary.
 *
 * Pairs with phase 597 (structural quartet — presence), phase 596
 * (meta.type='problem'), phase 665 (meta keys strict), phase 666
 * (export keys strict).
 */
describe('ESLint rule meta.schema empty invariant (phase 669)', () => {
  it('every meta.schema deepEqual []', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: { schema?: unknown } };
      };
      const schema = mod?.default?.meta?.schema;
      if (!Array.isArray(schema) || schema.length !== 0) {
        offenders.push(`${f}: schema=${JSON.stringify(schema)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
