import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

/**
 * phase 679: invariant that every depcruise forbidden rule has a `to`
 * field present (even if it's an empty object {}).
 *
 * Mirrors phase 678 (from field presence) to the `to` side. Rule
 * from + to is a source/target pair; both must be explicit (even
 * empty {}) for the rule to be interpretable.
 *
 * Pairs with phase 678 (from presence), phase 599 (to.path|circular|
 * dep|from.orphan content), phase 595 (from.path|orphan content).
 */
describe('depcruise forbidden rule to presence invariant (phase 679)', () => {
  it('every forbidden rule has to field defined', () => {
    const cfgPath = path.resolve(__dirname, '../../../.config/dependency-cruiser.cjs');
    const cfg = require(cfgPath) as {
      forbidden: Array<{ name: string; to?: unknown }>;
    };
    const missing = cfg.forbidden
      .filter(r => r.to === undefined)
      .map(r => r.name);
    expect(missing).toEqual([]);
  });
});
