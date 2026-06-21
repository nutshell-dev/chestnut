import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * phase 665: invariant that every chestnut-custom rule's `meta` has
 * exactly {type, docs, schema, messages} as keys — no extra fields like
 * fixable, hasSuggestions, deprecated, replacedBy.
 *
 * Rationale (ML#3 single-source meta shape): chestnut-custom rule meta
 * structure should be uniform. Additional ESLint meta fields (fixable,
 * etc.) — if needed — should be added across all rules in one phase +
 * accompanied by their own invariant.
 *
 * Mirrors phase 664 (meta.docs keys strict) at the meta layer above.
 * Pairs with phase 597 (structural quartet — presence), phase 596
 * (meta.type='problem'), phase 664 (docs keys strict).
 */
describe('ESLint rule meta keys strict invariant (phase 665)', () => {
  it('every meta has exactly keys {type, docs, schema, messages}', async () => {
    const rulesDir = path.resolve(__dirname, '../../../.config/eslint-rules');
    const files = fs
      .readdirSync(rulesDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const EXPECTED = ['docs', 'messages', 'schema', 'type'];
    const offenders: string[] = [];
    for (const f of files) {
      const rulePath = path.join(rulesDir, f);
      const mod = (await import(rulePath)) as {
        default?: { meta?: Record<string, unknown> };
      };
      const meta = mod?.default?.meta ?? {};
      const actual = Object.keys(meta).sort();
      if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
        offenders.push(`${f}: keys=${actual.join(',')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
